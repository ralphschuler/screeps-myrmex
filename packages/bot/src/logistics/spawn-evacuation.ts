import type { BudgetRequest } from "../colony";
import {
  LAYOUT_SPAWN_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_RECORDS,
  MAX_LAYOUT_SPAWN_ENERGY,
  layoutSpawnEvacuationBudgetIssuer,
  layoutSpawnEvacuationFlowId,
  type LayoutRecord,
} from "../layout";
import type { WorldSnapshot } from "../world/snapshot";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutSpawnEvacuationProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly demands: LogisticsResourceDemandProjection;
}

/** Keeps only budgets whose exact projected flow remains authorized after spawn arbitration. */
export function authorizedLayoutSpawnEvacuationBudgets(
  projection: LayoutSpawnEvacuationProjection,
  authorizedFlowIds: ReadonlySet<string>,
): readonly BudgetRequest[] {
  const authorizedIssuers = new Set(
    projection.demands.edges.flatMap(({ budgetBinding, id }) =>
      authorizedFlowIds.has(id) && budgetBinding?.category === "optional-growth"
        ? [budgetBinding.issuer]
        : [],
    ),
  );
  return freeze(projection.budgets.filter(({ issuer }) => authorizedIssuers.has(issuer)));
}

/** Projects one fixed layout-owned spawn evacuation per room into the sole logistics graph. */
export function projectLayoutSpawnEvacuations(input: {
  readonly existingBudgets: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly status: string;
  }[];
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): LayoutSpawnEvacuationProjection {
  if (input.records.length > MAX_LAYOUT_RECORDS) return emptyProjection();
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedSinkTargetIds: string[] = [];

  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.spawnEvacuation;
    if (
      evacuation === undefined ||
      evacuation.amount <= 0 ||
      evacuation.amount > MAX_LAYOUT_SPAWN_ENERGY ||
      evacuation.replacementInitialEnergy < 0 ||
      evacuation.replacementInitialEnergy + evacuation.amount > MAX_LAYOUT_SPAWN_ENERGY ||
      evacuation.expiresAt - evacuation.startedAt !== LAYOUT_SPAWN_EVACUATION_TIMEOUT_TICKS ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (room?.controller?.ownership !== "owned" || room.observedAt !== input.tick) continue;
    // Keep ordinary logistics from refilling a durable obsolete target even when current drift
    // suppresses the optional evacuation flow.
    suppressedSinkTargetIds.push(evacuation.sourceId);
    if (room.hostileCreeps.length > 0) continue;
    const sources = room.ownedSpawns.filter(({ id }) => id === evacuation.sourceId);
    const replacements = room.ownedSpawns.filter(({ id }) => id === evacuation.replacementId);
    const source = sources[0];
    const replacement = replacements[0];
    if (
      sources.length !== 1 ||
      replacements.length !== 1 ||
      source?.active !== true ||
      replacement?.active !== true ||
      source.spawning !== null ||
      replacement.spawning !== null
    )
      continue;
    const sourceEnergy = exactEnergy(source.store);
    const replacementEnergy = exactEnergy(replacement.store);
    const replacementFreeCapacity = replacement.store.freeCapacity;
    if (
      sourceEnergy === null ||
      replacementEnergy === null ||
      replacementFreeCapacity === null ||
      sourceEnergy > evacuation.amount ||
      (sourceEnergy > 0 && replacementEnergy < evacuation.replacementInitialEnergy) ||
      replacementEnergy > evacuation.replacementInitialEnergy + evacuation.amount - sourceEnergy
    )
      continue;
    const flowId = layoutSpawnEvacuationFlowId(room.name, evacuation);
    const issuer = layoutSpawnEvacuationBudgetIssuer(room.name, evacuation);
    if (flowId === null || issuer === null) continue;
    const sourceNodeId = `${flowId}:source:energy`;
    const sinkNodeId = `${flowId}:sink:energy`;
    nodes.push(
      {
        colonyId: room.name,
        freeCapacity: 0,
        id: sourceNodeId,
        kind: "source",
        observedAmount: sourceEnergy,
        observedAt: input.tick,
        position: source.pos,
        priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
        resourceType: "energy",
      },
      {
        capacityReservationKey: `spawn:${room.name}:${replacement.id}:energy-capacity`,
        colonyId: room.name,
        freeCapacity: replacementFreeCapacity,
        id: sinkNodeId,
        kind: "sink",
        observedAmount: 0,
        observedAt: input.tick,
        position: replacement.pos,
        priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
        resourceType: "energy",
      },
    );
    endpoints.push(
      {
        acquireAction: "withdraw",
        freeCapacity: 0,
        nodeId: sourceNodeId,
        observedAmount: sourceEnergy,
        observedAt: input.tick,
        position: source.pos,
        resourceType: "energy",
        targetId: source.id,
      },
      {
        freeCapacity: replacementFreeCapacity,
        nodeId: sinkNodeId,
        observedAmount: 0,
        observedAt: input.tick,
        position: replacement.pos,
        resourceType: "energy",
        targetId: replacement.id,
      },
    );
    edges.push({
      budgetBinding: { category: "optional-growth", issuer },
      id: flowId,
      maximumAmount: evacuation.amount,
      roundTripTicks: Math.max(
        1,
        Math.max(
          Math.abs(source.pos.x - replacement.pos.x),
          Math.abs(source.pos.y - replacement.pos.y),
        ) * 2,
      ),
      sinkNodeId,
      sourceNodeId,
    });
    if (sourceEnergy > 0) suppressedSinkTargetIds.push(replacement.id);
    budgets.push({
      colonyId: room.name,
      category: "optional-growth",
      cpu: { desired: 100, minimum: 0 },
      energy: null,
      expiresAt: evacuation.expiresAt,
      issuer,
      revision: renewedRevision(input.existingBudgets, room.name, issuer, evacuation.startedAt + 1),
      spawn: null,
    });
  }

  return freeze({ budgets, demands: { edges, endpoints, nodes, suppressedSinkTargetIds } });
}

function renewedRevision(
  existing: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly status: string;
  }[],
  colonyId: string,
  issuer: string,
  proposed: number,
): number {
  const prior = existing.find(
    (entry) =>
      entry.colonyId === colonyId &&
      entry.category === "optional-growth" &&
      entry.issuer === issuer,
  );
  if (prior === undefined) return proposed;
  return prior.status === "active" || prior.status === "pending"
    ? Math.max(proposed, prior.revision)
    : Math.max(proposed, prior.revision + 1);
}

function exactEnergy(store: {
  readonly capacity: number | null;
  readonly freeCapacity: number | null;
  readonly resources: readonly { readonly amount: number; readonly resourceType: string }[];
  readonly usedCapacity: number;
}): number | null {
  if (
    store.capacity !== MAX_LAYOUT_SPAWN_ENERGY ||
    store.resources.length > 1 ||
    store.resources.some(
      ({ amount, resourceType }) =>
        resourceType !== "energy" || !Number.isSafeInteger(amount) || amount <= 0,
    )
  )
    return null;
  const energy = store.resources[0]?.amount ?? 0;
  return Number.isSafeInteger(energy) &&
    energy >= 0 &&
    energy <= MAX_LAYOUT_SPAWN_ENERGY &&
    energy === store.usedCapacity &&
    store.freeCapacity === MAX_LAYOUT_SPAWN_ENERGY - energy
    ? energy
    : null;
}

function emptyProjection(): LayoutSpawnEvacuationProjection {
  return freeze({
    budgets: [],
    demands: { edges: [], endpoints: [], nodes: [], suppressedSinkTargetIds: [] },
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
