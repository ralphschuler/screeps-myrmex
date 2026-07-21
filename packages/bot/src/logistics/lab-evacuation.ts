import type { BudgetRequest } from "../colony";
import type { LabMigrationRoomView } from "../industry/lab-composition";
import {
  LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_LAB_ENERGY,
  MAX_LAYOUT_LAB_EVACUATION_FLOWS,
  MAX_LAYOUT_LAB_MINERAL,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_STORAGE_RESOURCES,
  layoutLabEvacuationBudgetIssuers,
  layoutLabEvacuationFlowIds,
  type LayoutLabEvacuation,
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

/** Keeps each currently projected mixed pair atomic when logistics can execute only a prefix. */
export function completeExecutableLayoutLabEvacuationFlowIds(input: {
  readonly executableFlowIds: ReadonlySet<string>;
  readonly projectedFlowIds: ReadonlySet<string>;
  readonly records: readonly LayoutRecord[];
}): ReadonlySet<string> {
  const complete = new Set<string>();
  for (const record of input.records) {
    if (record.labEvacuation === undefined) continue;
    const flowIds = layoutLabEvacuationFlowIds(record.roomName, record.labEvacuation);
    if (flowIds === null) continue;
    const projected = flowIds.filter((flowId) => input.projectedFlowIds.has(flowId));
    if (projected.length > 0 && projected.every((flowId) => input.executableFlowIds.has(flowId))) {
      for (const flowId of projected) complete.add(flowId);
    }
  }
  return complete;
}

/** Projects quiescent or exact active-reaction layout-owned lab evacuation terms. */
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
      evacuation.expiresAt - evacuation.startedAt !== LAYOUT_LAB_EVACUATION_TIMEOUT_TICKS ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    const migration = input.migrationRooms.find(({ roomName }) => roomName === record.roomName);
    const shape = labEvacuationShape(evacuation);
    const quiescent = migration === undefined ? false : quiescentMigration(migration);
    const activeReaction =
      migration === undefined || shape === null
        ? false
        : activeReactionMigration(record, migration, evacuation, shape);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0 ||
      migration?.observedAt !== input.tick ||
      migration.assignment === null ||
      shape === null ||
      (!quiescent && !activeReaction)
    )
      continue;
    const effectiveAssignment = activeReaction
      ? (migration.assignmentHandoff?.assignment ?? migration.assignment)
      : migration.assignment;
    const assignedIds = new Set([
      ...effectiveAssignment.reagentLabIds,
      ...effectiveAssignment.productLabIds,
      ...effectiveAssignment.boostLabIds,
    ]);
    if (!assignedIds.has(evacuation.replacementId)) continue;
    const source = room.ownedLabs?.find(({ id }) => id === evacuation.sourceId);
    const replacement = room.ownedLabs?.find(({ id }) => id === evacuation.replacementId);
    if (source?.active !== true || source.cooldown !== 0 || replacement?.active !== true) continue;
    const sourceEnergy = exactLabEnergy(source);
    const replacementEnergy = exactLabEnergy(replacement);
    if (sourceEnergy === null || replacementEnergy === null) continue;

    const remainingEnergy = Math.max(
      sourceEnergy,
      shape.replacementInitialEnergy + shape.energyAmount - replacementEnergy,
    );
    if (
      sourceEnergy > shape.energyAmount ||
      (shape.energyAmount === 0 && sourceEnergy !== 0) ||
      (shape.energyAmount > 0 &&
        (replacementEnergy < shape.replacementInitialEnergy ||
          replacementEnergy + remainingEnergy > MAX_LAYOUT_LAB_ENERGY)) ||
      source.mineralAmount > shape.mineralAmount ||
      (shape.mineralAmount === 0 && (source.mineralAmount !== 0 || source.mineralType !== null)) ||
      (shape.mineralAmount > 0 &&
        source.mineralAmount > 0 &&
        source.mineralType !== shape.resourceType)
    )
      continue;

    let destination: OwnedStorageSnapshot | null = null;
    let destinationFreeCapacity = 0;
    let destinationResourceAmount = 0;
    if (shape.mineralAmount > 0) {
      const activeStorages = (room.ownedStorages ?? []).filter(({ active }) => active);
      destination = activeStorages.find(({ id }) => id === shape.destinationId) ?? null;
      const destinationStore = destination === null ? null : exactStorage(destination);
      destinationResourceAmount = destinationStore?.resources.get(shape.resourceType ?? "") ?? 0;
      const remainingMineral = Math.max(
        source.mineralAmount,
        shape.destinationInitialAmount + shape.mineralAmount - destinationResourceAmount,
      );
      if (
        activeStorages.length !== 1 ||
        destination === null ||
        migration.evacuationStorageId !== shape.destinationId ||
        destinationStore === null ||
        destinationResourceAmount < shape.destinationInitialAmount ||
        destinationStore.freeCapacity < remainingMineral
      )
        continue;
      destinationFreeCapacity = destinationStore.freeCapacity;
    }

    const flowIds = layoutLabEvacuationFlowIds(room.name, evacuation);
    const issuers = layoutLabEvacuationBudgetIssuers(room.name, evacuation);
    const expectedFlows = Number(shape.energyAmount > 0) + Number(shape.mineralAmount > 0);
    if (
      flowIds === null ||
      issuers === null ||
      flowIds.length !== expectedFlows ||
      issuers.length !== expectedFlows ||
      new Set(flowIds).size !== flowIds.length ||
      new Set(issuers).size !== issuers.length
    )
      continue;

    const terms: {
      readonly committedAmount: number;
      readonly flowId: string;
      readonly issuer: string;
      readonly resourceType: string;
      readonly sinkFreeCapacity: number;
      readonly sinkId: string;
      readonly sinkPosition: OwnedLabSnapshot["pos"];
      readonly sourceAmount: number;
      readonly workRemaining: boolean;
      readonly capacityReservationKey: string;
    }[] = [];
    let identityIndex = 0;
    if (shape.energyAmount > 0) {
      const flowId = flowIds[identityIndex];
      const issuer = issuers[identityIndex];
      if (flowId === undefined || issuer === undefined) continue;
      terms.push({
        capacityReservationKey: `lab:${room.name}:${replacement.id}:energy-capacity`,
        committedAmount: shape.energyAmount,
        flowId,
        issuer,
        resourceType: "energy",
        sinkFreeCapacity: MAX_LAYOUT_LAB_ENERGY - replacementEnergy,
        sinkId: replacement.id,
        sinkPosition: replacement.pos,
        sourceAmount: sourceEnergy,
        workRemaining:
          sourceEnergy > 0 ||
          replacementEnergy < shape.replacementInitialEnergy + shape.energyAmount,
      });
      identityIndex += 1;
    }
    if (shape.mineralAmount > 0) {
      const flowId = flowIds[identityIndex];
      const issuer = issuers[identityIndex];
      if (
        flowId === undefined ||
        issuer === undefined ||
        destination === null ||
        shape.resourceType === null
      )
        continue;
      terms.push({
        capacityReservationKey: aggregateStoreCapacityReservationKey(room.name, destination.id),
        committedAmount: shape.mineralAmount,
        flowId,
        issuer,
        resourceType: shape.resourceType,
        sinkFreeCapacity: destinationFreeCapacity,
        sinkId: destination.id,
        sinkPosition: destination.pos,
        sourceAmount: source.mineralAmount,
        workRemaining:
          source.mineralAmount > 0 ||
          destinationResourceAmount < shape.destinationInitialAmount + shape.mineralAmount,
      });
    }
    const activeTerms = terms.filter(({ workRemaining }) => workRemaining);
    for (const term of activeTerms) {
      const capacityReservationKey =
        term.resourceType === "energy"
          ? `lab:${room.name}:${replacement.id}:energy-capacity`
          : term.capacityReservationKey;
      const sourceNodeId = `${term.flowId}:source:${term.resourceType}`;
      const sinkNodeId = `${term.flowId}:sink:${term.resourceType}`;
      nodes.push(
        {
          colonyId: room.name,
          freeCapacity: 0,
          id: sourceNodeId,
          kind: "source",
          observedAmount: term.sourceAmount,
          observedAt: input.tick,
          position: source.pos,
          priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
          resourceType: term.resourceType,
        },
        {
          capacityReservationKey,
          colonyId: room.name,
          freeCapacity: term.sinkFreeCapacity,
          id: sinkNodeId,
          kind: "sink",
          observedAmount: 0,
          observedAt: input.tick,
          position: term.sinkPosition,
          priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
          resourceType: term.resourceType,
        },
      );
      endpoints.push(
        {
          acquireAction: "withdraw",
          freeCapacity: 0,
          nodeId: sourceNodeId,
          observedAmount: term.sourceAmount,
          observedAt: input.tick,
          position: source.pos,
          resourceType: term.resourceType,
          targetId: source.id,
        },
        {
          freeCapacity: term.sinkFreeCapacity,
          nodeId: sinkNodeId,
          observedAmount: 0,
          observedAt: input.tick,
          position: term.sinkPosition,
          resourceType: term.resourceType,
          targetId: term.sinkId,
        },
      );
      edges.push({
        budgetBinding: { category: "optional-growth", issuer: term.issuer },
        id: term.flowId,
        maximumAmount: term.committedAmount,
        roundTripTicks: Math.max(
          1,
          Math.max(
            Math.abs(source.pos.x - term.sinkPosition.x),
            Math.abs(source.pos.y - term.sinkPosition.y),
          ) * 2,
        ),
        sinkNodeId,
        sourceNodeId,
      });
      authorizedFlowIds.push(term.flowId);
      budgets.push({
        colonyId: room.name,
        category: "optional-growth",
        cpu: { desired: 100, minimum: 0 },
        energy: null,
        expiresAt: evacuation.expiresAt,
        issuer: term.issuer,
        revision: renewedRevision(
          input.existingBudgets,
          room.name,
          term.issuer,
          evacuation.startedAt + 1,
        ),
        spawn: null,
      });
    }
    if (activeTerms.length > 0) {
      suppressedSinkTargetIds.push(source.id, ...(shape.energyAmount > 0 ? [replacement.id] : []));
      suppressedSourceTargetIds.push(
        source.id,
        ...(shape.energyAmount > 0 ? [replacement.id] : []),
      );
    }
  }

  if (
    edges.length > MAX_LAYOUT_LAB_EVACUATION_FLOWS ||
    budgets.length > MAX_LAYOUT_LAB_EVACUATION_FLOWS ||
    nodes.length > MAX_LAYOUT_LAB_EVACUATION_FLOWS * 2 ||
    endpoints.length > MAX_LAYOUT_LAB_EVACUATION_FLOWS * 2
  )
    return emptyProjection();
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

function quiescentMigration(migration: LabMigrationRoomView): boolean {
  return migration.quiescent && migration.activity.length === 0;
}

function activeReactionMigration(
  record: LayoutRecord,
  migration: LabMigrationRoomView,
  evacuation: LayoutLabEvacuation,
  shape: NonNullable<ReturnType<typeof labEvacuationShape>>,
): boolean {
  const handoff = migration.assignmentHandoff;
  const current = migration.assignment;
  if (
    current === null ||
    migration.quiescent ||
    !migration.activity.includes("commitment") ||
    Number(shape.energyAmount > 0) + Number(shape.mineralAmount > 0) !== 1 ||
    "energyAmount" in evacuation ||
    handoff?.status !== "ready" ||
    handoff.targetLabId !== evacuation.sourceId ||
    handoff.layoutFingerprint !== record.fingerprint ||
    handoff.fromFingerprint !== current.fingerprint ||
    handoff.assignment.roomName !== record.roomName ||
    !sameAssignmentRoles(current, handoff.assignment)
  )
    return false;
  const assignedIds = new Set([
    ...handoff.assignment.reagentLabIds,
    ...handoff.assignment.productLabIds,
    ...handoff.assignment.boostLabIds,
  ]);
  return !assignedIds.has(evacuation.sourceId) && assignedIds.has(evacuation.replacementId);
}

function sameAssignmentRoles(
  left: NonNullable<LabMigrationRoomView["assignment"]>,
  right: NonNullable<LabMigrationRoomView["assignment"]>,
): boolean {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    same(left.reagentLabIds, right.reagentLabIds) &&
    same(left.productLabIds, right.productLabIds) &&
    same(left.boostLabIds, right.boostLabIds)
  );
}

function labEvacuationShape(evacuation: LayoutLabEvacuation): {
  readonly destinationId: string | null;
  readonly destinationInitialAmount: number;
  readonly energyAmount: number;
  readonly mineralAmount: number;
  readonly replacementInitialEnergy: number;
  readonly resourceType: string | null;
} | null {
  const mixed = "energyAmount" in evacuation;
  const mineral = "resourceType" in evacuation;
  const energyAmount = mixed ? evacuation.energyAmount : mineral ? 0 : evacuation.amount;
  const mineralAmount = mixed ? evacuation.mineralAmount : mineral ? evacuation.amount : 0;
  const replacementInitialEnergy =
    "replacementInitialEnergy" in evacuation ? evacuation.replacementInitialEnergy : 0;
  const destinationId = mineral ? evacuation.destinationId : null;
  const destinationInitialAmount = mineral ? evacuation.destinationInitialAmount : 0;
  const resourceType = mineral ? evacuation.resourceType : null;
  if (
    !Number.isSafeInteger(energyAmount) ||
    energyAmount < 0 ||
    energyAmount > MAX_LAYOUT_LAB_ENERGY ||
    !Number.isSafeInteger(mineralAmount) ||
    mineralAmount < 0 ||
    mineralAmount > MAX_LAYOUT_LAB_MINERAL ||
    energyAmount + mineralAmount <= 0 ||
    !Number.isSafeInteger(replacementInitialEnergy) ||
    replacementInitialEnergy < 0 ||
    replacementInitialEnergy + energyAmount > MAX_LAYOUT_LAB_ENERGY ||
    (mineralAmount > 0 &&
      (resourceType === null ||
        resourceType === "energy" ||
        resourceType.length === 0 ||
        resourceType.length > 64 ||
        resourceType !== resourceType.trim() ||
        destinationId === null ||
        destinationId === evacuation.sourceId ||
        destinationId === evacuation.replacementId ||
        !Number.isSafeInteger(destinationInitialAmount) ||
        destinationInitialAmount < 0 ||
        destinationInitialAmount + mineralAmount > MAX_LAYOUT_STORAGE_CAPACITY))
  )
    return null;
  return {
    destinationId,
    destinationInitialAmount,
    energyAmount,
    mineralAmount,
    replacementInitialEnergy,
    resourceType,
  };
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
