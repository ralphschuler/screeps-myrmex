import type { BudgetRequest } from "../colony";
import type { LabMigrationRoomView } from "../industry/lab-composition";
import {
  LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_LAB_ENERGY,
  MAX_LAYOUT_LAB_MINERAL,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_STORAGE_RESOURCES,
  layoutLabEvacuationBudgetIssuer,
  layoutLabEvacuationFlowId,
  type LayoutRecord,
} from "../layout";
import type { OwnedLabSnapshot, OwnedStorageSnapshot, WorldSnapshot } from "../world/snapshot";
import { aggregateStoreCapacityReservationKey } from "./planner";
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
      evacuation.expiresAt - evacuation.startedAt !== LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    const mineralEvacuation = "resourceType" in evacuation;
    if (
      mineralEvacuation
        ? evacuation.amount > MAX_LAYOUT_LAB_MINERAL ||
          evacuation.resourceType === "energy" ||
          evacuation.destinationInitialAmount < 0 ||
          evacuation.destinationInitialAmount + evacuation.amount > MAX_LAYOUT_STORAGE_CAPACITY
        : evacuation.amount > MAX_LAYOUT_LAB_ENERGY ||
          evacuation.replacementInitialEnergy < 0 ||
          evacuation.replacementInitialEnergy + evacuation.amount > MAX_LAYOUT_LAB_ENERGY
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
    if (source?.active !== true || source.cooldown !== 0 || replacement?.active !== true) continue;
    const sourceEnergy = exactLabEnergy(source);
    const replacementEnergy = exactLabEnergy(replacement);
    if (sourceEnergy === null || replacementEnergy === null) continue;

    let resourceType: string;
    let sourceAmount: number;
    let sinkId: string;
    let sinkPosition: OwnedLabSnapshot["pos"];
    let sinkFreeCapacity: number;
    let capacityReservationKey: string;
    if (mineralEvacuation) {
      const activeStorages = (room.ownedStorages ?? []).filter(({ active }) => active);
      const destination = activeStorages.find(({ id }) => id === evacuation.destinationId);
      const destinationStore = destination === undefined ? null : exactStorage(destination);
      const destinationResourceAmount =
        destinationStore?.resources.get(evacuation.resourceType) ?? 0;
      if (
        activeStorages.length !== 1 ||
        destination === undefined ||
        migration.evacuationStorageId !== evacuation.destinationId ||
        destinationStore === null ||
        sourceEnergy !== 0 ||
        source.mineralType !== evacuation.resourceType ||
        source.mineralAmount <= 0 ||
        source.mineralAmount > evacuation.amount ||
        destinationResourceAmount < evacuation.destinationInitialAmount ||
        destinationStore.freeCapacity < source.mineralAmount
      )
        continue;
      resourceType = evacuation.resourceType;
      sourceAmount = source.mineralAmount;
      sinkId = destination.id;
      sinkPosition = destination.pos;
      sinkFreeCapacity = destinationStore.freeCapacity;
      capacityReservationKey = aggregateStoreCapacityReservationKey(room.name, destination.id);
    } else {
      if (
        source.mineralAmount !== 0 ||
        source.mineralType !== null ||
        sourceEnergy > evacuation.amount ||
        replacementEnergy < evacuation.replacementInitialEnergy ||
        replacementEnergy + sourceEnergy > MAX_LAYOUT_LAB_ENERGY
      )
        continue;
      resourceType = "energy";
      sourceAmount = sourceEnergy;
      sinkId = replacement.id;
      sinkPosition = replacement.pos;
      sinkFreeCapacity = MAX_LAYOUT_LAB_ENERGY - replacementEnergy;
      capacityReservationKey = `lab:${room.name}:${replacement.id}:energy-capacity`;
    }
    const flowId = layoutLabEvacuationFlowId(room.name, evacuation);
    const issuer = layoutLabEvacuationBudgetIssuer(room.name, evacuation);
    if (flowId === null || issuer === null) continue;
    const sourceNodeId = `${flowId}:source:${resourceType}`;
    const sinkNodeId = `${flowId}:sink:${resourceType}`;
    nodes.push(
      {
        colonyId: room.name,
        freeCapacity: 0,
        id: sourceNodeId,
        kind: "source",
        observedAmount: sourceAmount,
        observedAt: input.tick,
        position: source.pos,
        priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
        resourceType,
      },
      {
        capacityReservationKey,
        colonyId: room.name,
        freeCapacity: sinkFreeCapacity,
        id: sinkNodeId,
        kind: "sink",
        observedAmount: 0,
        observedAt: input.tick,
        position: sinkPosition,
        priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
        resourceType,
      },
    );
    endpoints.push(
      {
        acquireAction: "withdraw",
        freeCapacity: 0,
        nodeId: sourceNodeId,
        observedAmount: sourceAmount,
        observedAt: input.tick,
        position: source.pos,
        resourceType,
        targetId: source.id,
      },
      {
        freeCapacity: sinkFreeCapacity,
        nodeId: sinkNodeId,
        observedAmount: 0,
        observedAt: input.tick,
        position: sinkPosition,
        resourceType,
        targetId: sinkId,
      },
    );
    edges.push({
      budgetBinding: { category: "optional-growth", issuer },
      id: flowId,
      maximumAmount: evacuation.amount,
      roundTripTicks: Math.max(
        1,
        Math.max(Math.abs(source.pos.x - sinkPosition.x), Math.abs(source.pos.y - sinkPosition.y)) *
          2,
      ),
      sinkNodeId,
      sourceNodeId,
    });
    authorizedFlowIds.push(flowId);
    suppressedSinkTargetIds.push(source.id, ...(mineralEvacuation ? [] : [replacement.id]));
    suppressedSourceTargetIds.push(source.id, ...(mineralEvacuation ? [] : [replacement.id]));
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

function exactStorage(storage: OwnedStorageSnapshot): {
  readonly freeCapacity: number;
  readonly resources: ReadonlyMap<string, number>;
} | null {
  if (
    storage.store.capacity !== MAX_LAYOUT_STORAGE_CAPACITY ||
    storage.store.freeCapacity === null ||
    !Number.isSafeInteger(storage.store.freeCapacity) ||
    storage.store.freeCapacity < 0 ||
    !Number.isSafeInteger(storage.store.usedCapacity) ||
    storage.store.usedCapacity < 0 ||
    storage.store.freeCapacity + storage.store.usedCapacity !== MAX_LAYOUT_STORAGE_CAPACITY ||
    storage.store.resources.length > MAX_LAYOUT_STORAGE_RESOURCES
  )
    return null;
  const resources = new Map<string, number>();
  let used = 0;
  for (const { amount, resourceType } of storage.store.resources) {
    if (
      resources.has(resourceType) ||
      resourceType.length === 0 ||
      resourceType.length > 64 ||
      resourceType !== resourceType.trim() ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    )
      return null;
    resources.set(resourceType, amount);
    used += amount;
  }
  return used === storage.store.usedCapacity
    ? { freeCapacity: storage.store.freeCapacity, resources }
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
