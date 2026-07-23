import type { BudgetRequest } from "../colony";
import {
  LAYOUT_TOWER_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_RECORDS,
  MAX_LAYOUT_TOWER_ENERGY,
  MINIMUM_OPERATIONAL_TOWER_ENERGY,
  layoutTowerEvacuationBudgetIssuer,
  layoutTowerEvacuationFlowId,
  type LayoutRecord,
} from "../layout";
import type { WorldSnapshot } from "../world/snapshot";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutTowerEvacuationProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly demands: LogisticsResourceDemandProjection;
}

/** Durable refill suppression for a persisted term, independent of optional-work authorization. */
export function projectLayoutTowerEvacuationSuppressedSinkTargetIds(input: {
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): readonly string[] {
  if (input.records.length > MAX_LAYOUT_RECORDS) return Object.freeze([]);
  const suppressed = new Set<string>();
  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.towerEvacuation;
    if (!isCurrentLayoutTowerEvacuationTerm(evacuation, input.tick)) continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (room?.controller?.ownership !== "owned" || room.observedAt !== input.tick) continue;
    suppressed.add(evacuation.sourceId);
    suppressed.add(evacuation.replacementId);
  }
  return Object.freeze([...suppressed]);
}

/** Fresh command-free completion evidence for an already-authorized tower evacuation. */
export function completedLayoutTowerEvacuationRoomNames(input: {
  readonly activeFlowIds: ReadonlySet<string>;
  readonly activeTargetIds: ReadonlySet<string>;
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): readonly string[] {
  if (input.records.length > MAX_LAYOUT_RECORDS) return Object.freeze([]);
  const completed: string[] = [];
  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.towerEvacuation;
    if (
      !isCurrentLayoutTowerEvacuationTerm(evacuation, input.tick) ||
      input.tick <= evacuation.startedAt
    )
      continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0
    )
      continue;
    const evidence = exactTowerEvacuationEvidence(room.ownedTowers, evacuation);
    if (
      evidence === null ||
      evidence.sourceEnergy !== 0 ||
      evidence.replacementEnergy !== evacuation.replacementInitialEnergy + evacuation.amount
    )
      continue;
    const flowId = layoutTowerEvacuationFlowId(room.name, evacuation);
    if (
      flowId === null ||
      input.activeFlowIds.has(flowId) ||
      input.activeTargetIds.has(evidence.source.id) ||
      input.activeTargetIds.has(evidence.replacement.id)
    )
      continue;
    completed.push(room.name);
  }
  return Object.freeze(completed);
}

/** Projects layout-owned tower evacuation terms into the sole logistics graph and budget owner. */
export function projectLayoutTowerEvacuations(input: {
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
}): LayoutTowerEvacuationProjection {
  if (input.records.length > MAX_LAYOUT_RECORDS) return emptyProjection();
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedSinkTargetIds = projectLayoutTowerEvacuationSuppressedSinkTargetIds(input);

  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.towerEvacuation;
    if (!isCurrentLayoutTowerEvacuationTerm(evacuation, input.tick)) continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0
    )
      continue;
    const evidence = exactTowerEvacuationEvidence(room.ownedTowers, evacuation);
    if (evidence === null) continue;
    const { replacement, source, sourceEnergy } = evidence;
    const replacementFreeCapacity = replacement.store.freeCapacity;
    if (replacementFreeCapacity === null) continue;
    const flowId = layoutTowerEvacuationFlowId(room.name, evacuation);
    const issuer = layoutTowerEvacuationBudgetIssuer(room.name, evacuation);
    if (flowId === null || issuer === null) continue;
    const sourceNodeId = `${flowId}:source:energy`;
    const sinkNodeId = `${flowId}:sink:energy`;
    nodes.push({
      colonyId: room.name,
      freeCapacity: 0,
      id: sourceNodeId,
      kind: "source",
      observedAmount: sourceEnergy,
      observedAt: input.tick,
      position: source.pos,
      priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
      resourceType: "energy",
    });
    nodes.push({
      capacityReservationKey: `tower:${room.name}:${replacement.id}:energy-capacity`,
      colonyId: room.name,
      freeCapacity: replacementFreeCapacity,
      id: sinkNodeId,
      kind: "sink",
      observedAmount: 0,
      observedAt: input.tick,
      position: replacement.pos,
      priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
      resourceType: "energy",
    });
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

  return freeze({
    budgets,
    demands: { edges, endpoints, nodes, suppressedSinkTargetIds },
  });
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

function isCurrentLayoutTowerEvacuationTerm(
  evacuation: LayoutRecord["towerEvacuation"],
  tick: number,
): evacuation is NonNullable<LayoutRecord["towerEvacuation"]> {
  return (
    evacuation !== undefined &&
    evacuation.amount > 0 &&
    evacuation.amount <= MAX_LAYOUT_TOWER_ENERGY &&
    evacuation.replacementInitialEnergy >= MINIMUM_OPERATIONAL_TOWER_ENERGY &&
    evacuation.replacementInitialEnergy + evacuation.amount <= MAX_LAYOUT_TOWER_ENERGY &&
    evacuation.expiresAt - evacuation.startedAt === LAYOUT_TOWER_EVACUATION_TIMEOUT_TICKS &&
    tick < evacuation.expiresAt
  );
}

function exactTowerEvacuationEvidence(
  towers: WorldSnapshot["rooms"][number]["ownedTowers"],
  evacuation: NonNullable<LayoutRecord["towerEvacuation"]>,
): {
  readonly replacement: WorldSnapshot["rooms"][number]["ownedTowers"][number];
  readonly replacementEnergy: number;
  readonly source: WorldSnapshot["rooms"][number]["ownedTowers"][number];
  readonly sourceEnergy: number;
} | null {
  const sources = towers.filter(({ id }) => id === evacuation.sourceId);
  const replacements = towers.filter(({ id }) => id === evacuation.replacementId);
  const source = sources[0];
  const replacement = replacements[0];
  if (
    sources.length !== 1 ||
    replacements.length !== 1 ||
    source?.active !== true ||
    replacement?.active !== true ||
    source.id === replacement.id
  )
    return null;
  const sourceEnergy = exactTowerStoreEnergy(source.store);
  const replacementEnergy = exactTowerStoreEnergy(replacement.store);
  if (
    sourceEnergy === null ||
    replacementEnergy === null ||
    sourceEnergy > evacuation.amount ||
    replacementEnergy < evacuation.replacementInitialEnergy ||
    sourceEnergy + replacementEnergy - evacuation.replacementInitialEnergy > evacuation.amount
  )
    return null;
  return { replacement, replacementEnergy, source, sourceEnergy };
}

function exactTowerStoreEnergy(store: {
  readonly capacity: number | null;
  readonly freeCapacity: number | null;
  readonly resources: readonly { readonly amount: number; readonly resourceType: string }[];
  readonly usedCapacity: number;
}): number | null {
  if (
    store.capacity !== MAX_LAYOUT_TOWER_ENERGY ||
    store.resources.length > 1 ||
    store.resources.some(
      ({ amount, resourceType }) =>
        resourceType !== "energy" || !Number.isSafeInteger(amount) || amount < 0,
    )
  )
    return null;
  const energy = store.resources[0]?.amount ?? 0;
  return Number.isSafeInteger(energy) &&
    energy >= 0 &&
    energy <= MAX_LAYOUT_TOWER_ENERGY &&
    energy === store.usedCapacity &&
    store.freeCapacity === MAX_LAYOUT_TOWER_ENERGY - energy
    ? energy
    : null;
}

function emptyProjection(): LayoutTowerEvacuationProjection {
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
