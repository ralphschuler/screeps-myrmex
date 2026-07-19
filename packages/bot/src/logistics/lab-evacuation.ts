import type { BudgetRequest } from "../colony";
import type { LabMigrationRoomView } from "../industry/lab-composition";
import {
  LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_LAB_ENERGY,
  MAX_LAYOUT_LAB_MINERAL,
  layoutLabEvacuationBudgetIssuer,
  layoutLabEvacuationFlowId,
  type LayoutRecord,
} from "../layout";
import type { OwnedLabSnapshot, WorldSnapshot } from "../world/snapshot";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutLabEvacuationProjection {
  readonly authorizedFlowIds: readonly string[];
  readonly budgets: readonly BudgetRequest[];
  readonly demands: LogisticsResourceDemandProjection;
}

/** Projects currently quiescent layout-owned lab evacuation terms into the sole logistics graph. */
export function projectLayoutLabEvacuations(input: {
  readonly existingBudgets: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly status: string;
  }[];
  readonly migrationRooms: readonly LabMigrationRoomView[];
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): LayoutLabEvacuationProjection {
  if (input.records.length > 64 || input.migrationRooms.length > 64) return emptyProjection();
  const authorizedFlowIds: string[] = [];
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedSinkTargetIds: string[] = [];
  const suppressedSourceTargetIds: string[] = [];

  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.labEvacuation;
    if (
      evacuation === undefined ||
      evacuation.amount <= 0 ||
      evacuation.amount > MAX_LAYOUT_LAB_ENERGY ||
      evacuation.replacementInitialEnergy < 0 ||
      evacuation.replacementInitialEnergy + evacuation.amount > MAX_LAYOUT_LAB_ENERGY ||
      evacuation.expiresAt - evacuation.startedAt !== LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    const migration = input.migrationRooms.find(({ roomName }) => roomName === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0 ||
      migration?.observedAt !== input.tick ||
      !migration.quiescent ||
      migration.activity.length !== 0 ||
      migration.assignment === null
    )
      continue;
    const assignedIds = new Set([
      ...migration.assignment.reagentLabIds,
      ...migration.assignment.productLabIds,
      ...migration.assignment.boostLabIds,
    ]);
    if (!assignedIds.has(evacuation.replacementId)) continue;
    const source = room.ownedLabs?.find(({ id }) => id === evacuation.sourceId);
    const replacement = room.ownedLabs?.find(({ id }) => id === evacuation.replacementId);
    if (
      source?.active !== true ||
      source.cooldown !== 0 ||
      replacement?.active !== true ||
      source.mineralAmount !== 0 ||
      source.mineralType !== null
    )
      continue;
    const sourceEnergy = exactLabEnergy(source);
    const replacementEnergy = exactLabEnergy(replacement);
    if (
      sourceEnergy === null ||
      replacementEnergy === null ||
      sourceEnergy > evacuation.amount ||
      replacementEnergy < evacuation.replacementInitialEnergy ||
      replacementEnergy + sourceEnergy > MAX_LAYOUT_LAB_ENERGY
    )
      continue;
    const flowId = layoutLabEvacuationFlowId(room.name, evacuation);
    const issuer = layoutLabEvacuationBudgetIssuer(room.name, evacuation);
    if (flowId === null || issuer === null) continue;
    const sourceNodeId = `${flowId}:source:energy`;
    const sinkNodeId = `${flowId}:sink:energy`;
    const replacementFreeCapacity = MAX_LAYOUT_LAB_ENERGY - replacementEnergy;
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
        capacityReservationKey: `lab:${room.name}:${replacement.id}:energy-capacity`,
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
    authorizedFlowIds.push(flowId);
    suppressedSinkTargetIds.push(source.id, replacement.id);
    suppressedSourceTargetIds.push(source.id, replacement.id);
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
    authorizedFlowIds,
    budgets,
    demands: {
      edges,
      endpoints,
      nodes,
      suppressedSinkTargetIds,
      suppressedSourceTargetIds,
    },
  });
}

function exactLabEnergy(lab: OwnedLabSnapshot): number | null {
  if (
    lab.energyCapacity !== MAX_LAYOUT_LAB_ENERGY ||
    lab.mineralCapacity !== MAX_LAYOUT_LAB_MINERAL ||
    !Number.isSafeInteger(lab.energy) ||
    lab.energy < 0 ||
    lab.energy > MAX_LAYOUT_LAB_ENERGY ||
    !Number.isSafeInteger(lab.mineralAmount) ||
    lab.mineralAmount < 0 ||
    lab.mineralAmount > MAX_LAYOUT_LAB_MINERAL ||
    (lab.mineralAmount === 0) !== (lab.mineralType === null) ||
    lab.mineralType === "energy" ||
    lab.store.usedCapacity !== lab.energy + lab.mineralAmount
  )
    return null;
  const resources = new Map<string, number>();
  for (const { amount, resourceType } of lab.store.resources) {
    if (
      resources.has(resourceType) ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      (resourceType !== "energy" && resourceType !== lab.mineralType)
    )
      return null;
    resources.set(resourceType, amount);
  }
  return (resources.get("energy") ?? 0) === lab.energy &&
    (lab.mineralType === null ? 0 : (resources.get(lab.mineralType) ?? 0)) === lab.mineralAmount &&
    resources.size === Number(lab.energy > 0) + Number(lab.mineralAmount > 0)
    ? lab.energy
    : null;
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

function emptyProjection(): LayoutLabEvacuationProjection {
  return freeze({
    authorizedFlowIds: [],
    budgets: [],
    demands: {
      edges: [],
      endpoints: [],
      nodes: [],
      suppressedSinkTargetIds: [],
      suppressedSourceTargetIds: [],
    },
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
