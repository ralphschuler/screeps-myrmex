import type { BudgetRequest } from "../colony";
import {
  LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_EXTENSION_ENERGY,
  layoutExtensionEvacuationBudgetIssuer,
  layoutExtensionEvacuationFlowId,
  type LayoutRecord,
} from "../layout";
import type { WorldSnapshot } from "../world/snapshot";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutExtensionEvacuationProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly demands: LogisticsResourceDemandProjection;
}

/** Projects persisted layout-owned evacuation terms into the sole logistics graph and budget owner. */
export function projectLayoutExtensionEvacuations(input: {
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
}): LayoutExtensionEvacuationProjection {
  if (input.records.length > 64) return emptyProjection();
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedSinkTargetIds: string[] = [];

  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.extensionEvacuation;
    if (
      evacuation === undefined ||
      evacuation.amount <= 0 ||
      evacuation.amount > MAX_LAYOUT_EXTENSION_ENERGY ||
      evacuation.replacementInitialEnergy < 0 ||
      evacuation.replacementInitialEnergy + evacuation.amount > MAX_LAYOUT_EXTENSION_ENERGY ||
      evacuation.expiresAt - evacuation.startedAt !== LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0
    )
      continue;
    const source = room.ownedExtensions.find(({ id }) => id === evacuation.sourceId);
    const replacement = room.ownedExtensions.find(({ id }) => id === evacuation.replacementId);
    if (source?.active !== true || replacement?.active !== true) continue;
    const sourceEnergy = exactEnergy(source.store);
    const replacementEnergy = exactEnergy(replacement.store);
    if (
      sourceEnergy === null ||
      replacementEnergy === null ||
      sourceEnergy > evacuation.amount ||
      replacementEnergy < evacuation.replacementInitialEnergy
    )
      continue;
    const flowId = layoutExtensionEvacuationFlowId(room.name, evacuation);
    const issuer = layoutExtensionEvacuationBudgetIssuer(room.name, evacuation);
    if (issuer === null) continue;
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
      capacityReservationKey: `extension:${room.name}:${replacement.id}:energy-capacity`,
      colonyId: room.name,
      freeCapacity: replacement.store.freeCapacity ?? 0,
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
        freeCapacity: replacement.store.freeCapacity ?? 0,
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
    suppressedSinkTargetIds.push(source.id);
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

  return freeze({
    budgets,
    demands: {
      edges,
      endpoints,
      nodes,
      suppressedSinkTargetIds,
    },
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

function exactEnergy(store: {
  readonly resources: readonly { readonly amount: number; readonly resourceType: string }[];
  readonly usedCapacity: number;
}): number | null {
  const energy = store.resources
    .filter(({ resourceType }) => resourceType === "energy")
    .reduce((total, resource) => total + resource.amount, 0);
  return Number.isSafeInteger(energy) &&
    energy >= 0 &&
    energy <= MAX_LAYOUT_EXTENSION_ENERGY &&
    energy === store.usedCapacity
    ? energy
    : null;
}

function emptyProjection(): LayoutExtensionEvacuationProjection {
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
