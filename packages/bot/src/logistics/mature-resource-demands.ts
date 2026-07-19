import type { MatureMechanicsCatalog } from "../industry/mature-capabilities";
import type {
  OwnedFactorySnapshot,
  OwnedNukerSnapshot,
  OwnedPowerSpawnSnapshot,
  OwnedRoomSnapshot,
  StoreSnapshot,
  WorldSnapshot,
} from "../world/snapshot";
import type { LogisticsContractEndpoint } from "./contracts";
import {
  aggregateStoreCapacityReservationKey,
  type LogisticsEdge,
  type LogisticsNode,
  type LogisticsPriorityClass,
} from "./planner";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

interface MatureObjectiveBase {
  readonly colonyId: string;
  readonly deadline: number;
  readonly endpointId: string;
  readonly funded: boolean;
  readonly id: string;
  readonly industryBudgetId: string;
  readonly mechanicsFingerprint: string;
  readonly priority: LogisticsPriorityClass;
  readonly revision: number;
  readonly structureId: string;
}

export interface FactoryBatchObjective extends MatureObjectiveBase {
  readonly batches: number;
  readonly kind: "factory-batch";
  readonly product: string;
}

export interface PowerProcessingObjective extends MatureObjectiveBase {
  readonly kind: "power-processing";
  readonly units: number;
}

export interface NukerStockObjective extends MatureObjectiveBase {
  readonly energyTarget: number;
  readonly ghodiumTarget: number;
  readonly kind: "nuker-stock";
}

export type MatureResourceObjective =
  FactoryBatchObjective | NukerStockObjective | PowerProcessingObjective;

export interface MatureResourceDemandLimits {
  readonly maximumAmountPerTransfer: number;
  readonly maximumBatches: number;
  readonly maximumEdges: number;
  readonly maximumNodes: number;
  readonly maximumObjectives: number;
  readonly maximumTransfersPerObjective: number;
}

export type MatureResourceDemandBlockerReason =
  | "capacity-infeasible"
  | "duplicate-objective-id"
  | "duplicate-objective-revision"
  | "edge-cap"
  | "expired-deadline"
  | "inactive-endpoint"
  | "inactive-structure"
  | "insufficient-stock"
  | "invalid-objective"
  | "missing-endpoint"
  | "missing-recipe"
  | "missing-structure"
  | "node-cap"
  | "objective-cap"
  | "stale-mechanics"
  | "transfer-cap"
  | "unfunded";

export interface MatureResourceDemandBlocker {
  readonly objectiveId: string;
  readonly reason: MatureResourceDemandBlockerReason;
  readonly revision: number;
}

export interface MatureResourceDemandDisposition {
  readonly objectiveId: string;
  readonly projectedAmount: number;
  readonly projectedTransfers: number;
  readonly revision: number;
  readonly status: "blocked" | "projected" | "satisfied";
}

export interface MatureResourceDemandProjection extends LogisticsResourceDemandProjection {
  readonly blockers: readonly MatureResourceDemandBlocker[];
  readonly dispositions: readonly MatureResourceDemandDisposition[];
}

interface Transfer {
  readonly amount: number;
  readonly mode: "drain" | "fill";
  readonly resourceType: string;
}

interface MatureStructureFact {
  readonly active: boolean;
  readonly id: string;
  readonly kind: "factory" | "nuker" | "power-spawn";
  readonly pos: { readonly roomName: string; readonly x: number; readonly y: number };
  readonly store: StoreSnapshot;
}

export function projectMatureResourceDemands(input: {
  readonly catalog: MatureMechanicsCatalog;
  readonly limits: MatureResourceDemandLimits;
  readonly objectives: readonly MatureResourceObjective[];
  readonly world: WorldSnapshot;
}): MatureResourceDemandProjection {
  const blockers: MatureResourceDemandBlocker[] = [];
  const dispositions: MatureResourceDemandDisposition[] = [];
  const edges: LogisticsEdge[] = [];
  const endpoints = new Map<string, LogisticsContractEndpoint>();
  const nodes = new Map<string, LogisticsNode>();
  const ordered = [...input.objectives].sort(compareObjectives);
  const duplicateIds = counts(ordered, ({ id }) => id);
  const duplicateRevisions = counts(
    ordered,
    ({ id, revision }) => `${id}\u0000${String(revision)}`,
  );
  const limitsValid = validLimits(input.limits);

  for (const [index, objective] of ordered.entries()) {
    let reason: MatureResourceDemandBlockerReason | null = null;
    if (!limitsValid || !validObjective(objective, input.limits)) reason = "invalid-objective";
    else if (
      (duplicateRevisions.get(`${objective.id}\u0000${String(objective.revision)}`) ?? 0) > 1
    )
      reason = "duplicate-objective-revision";
    else if ((duplicateIds.get(objective.id) ?? 0) > 1) reason = "duplicate-objective-id";
    else if (index >= input.limits.maximumObjectives) reason = "objective-cap";
    else if (!objective.funded) reason = "unfunded";
    else if (objective.mechanicsFingerprint !== input.catalog.fingerprint)
      reason = "stale-mechanics";
    else if (objective.deadline < input.world.observedAt) reason = "expired-deadline";

    const room = input.world.ownedRooms.find(({ name }) => name === objective.colonyId);
    const structure = room === undefined ? undefined : matureStructure(room, objective);
    const endpoint = room === undefined ? undefined : inventoryEndpoint(room, objective.endpointId);
    if (reason === null && structure === undefined) reason = "missing-structure";
    else if (reason === null && structure?.active !== true) reason = "inactive-structure";
    if (reason === null && endpoint === undefined) reason = "missing-endpoint";
    else if (reason === null && endpoint?.active !== true) reason = "inactive-endpoint";

    const transferResult =
      reason === null && structure !== undefined && endpoint !== undefined
        ? transfersFor(objective, structure, endpoint.store, input.catalog, input.limits)
        : { reason: null, transfers: [] as readonly Transfer[] };
    reason ??= transferResult.reason;
    if (
      reason !== null ||
      room === undefined ||
      structure === undefined ||
      endpoint === undefined
    ) {
      block(objective, reason ?? "invalid-objective", blockers, dispositions);
      continue;
    }
    if (transferResult.transfers.length === 0) {
      dispositions.push(disposition(objective, 0, 0, "satisfied"));
      continue;
    }
    if (transferResult.transfers.length > input.limits.maximumTransfersPerObjective) {
      block(objective, "transfer-cap", blockers, dispositions);
      continue;
    }

    const projected = transferResult.transfers.map((transfer) =>
      projectTransfer(objective, structure, endpoint, transfer, input.world.observedAt),
    );
    const newNodes = projected.filter(({ node }) => !nodes.has(node.id));
    if (nodes.size + newNodes.length > input.limits.maximumNodes) {
      block(objective, "node-cap", blockers, dispositions);
      continue;
    }
    if (edges.length + projected.length > input.limits.maximumEdges) {
      block(objective, "edge-cap", blockers, dispositions);
      continue;
    }
    for (const { edge, endpoint: projectedEndpoint, node } of projected) {
      nodes.set(node.id, node);
      endpoints.set(projectedEndpoint.nodeId, projectedEndpoint);
      edges.push(edge);
    }
    dispositions.push(
      disposition(
        objective,
        transferResult.transfers.reduce((total, { amount }) => total + amount, 0),
        transferResult.transfers.length,
        "projected",
      ),
    );
  }

  return freeze({
    blockers: freeze(blockers.sort(compareBlockers)),
    dispositions: freeze(dispositions.sort(compareDispositions)),
    edges: freeze(edges.sort((a, b) => compare(a.id, b.id))),
    endpoints: freeze([...endpoints.values()].sort((a, b) => compare(a.nodeId, b.nodeId))),
    nodes: freeze([...nodes.values()].sort((a, b) => compare(a.id, b.id))),
  });
}

function transfersFor(
  objective: MatureResourceObjective,
  structure: MatureStructureFact,
  endpointStore: StoreSnapshot,
  catalog: MatureMechanicsCatalog,
  limits: MatureResourceDemandLimits,
): {
  readonly reason: MatureResourceDemandBlockerReason | null;
  readonly transfers: readonly Transfer[];
} {
  if (structure.store.capacity === null || structure.store.freeCapacity === null)
    return transferFailure("capacity-infeasible");
  let transfers: readonly Transfer[];
  if (objective.kind === "factory-batch") {
    const factory = structure as MatureStructureFact & OwnedFactorySnapshot;
    const recipe = catalog.recipes.find(({ product }) => product === objective.product);
    if (recipe === undefined) return transferFailure("missing-recipe");
    if (recipe.level !== null && recipe.level !== factory.level)
      return transferFailure("invalid-objective");
    const componentTargets = recipe.components.map(({ amount, resourceType }) => ({
      amount: amount * objective.batches,
      resourceType,
    }));
    if (
      componentTargets.some(
        ({ amount }) => !positiveInteger(amount, limits.maximumAmountPerTransfer),
      )
    )
      return transferFailure("invalid-objective");
    const componentSet = new Set(componentTargets.map(({ resourceType }) => resourceType));
    const drains = structure.store.resources
      .filter(
        ({ amount, resourceType }) =>
          amount > 0 && (resourceType === objective.product || !componentSet.has(resourceType)),
      )
      .map(({ amount, resourceType }): Transfer => ({ amount, mode: "drain", resourceType }));
    const fills = componentTargets
      .map(({ amount, resourceType }): Transfer => ({
        amount: Math.max(0, amount - resourceAmount(structure.store, resourceType)),
        mode: "fill",
        resourceType,
      }))
      .filter(({ amount }) => amount > 0);
    const drainAmount = sumTransfers(drains);
    const fillAmount = sumTransfers(fills);
    const componentAmount = componentTargets.reduce((total, { amount }) => total + amount, 0);
    const outputAmount = recipe.amount * objective.batches;
    const projectedUsed =
      structure.store.usedCapacity - drainAmount + fillAmount - componentAmount + outputAmount;
    if (
      fillAmount > structure.store.freeCapacity + drainAmount ||
      projectedUsed < 0 ||
      projectedUsed > structure.store.capacity
    )
      return transferFailure("capacity-infeasible");
    transfers = [...drains, ...fills];
  } else if (objective.kind === "power-processing") {
    const powerTarget = Math.min(objective.units, catalog.constants.powerSpawnPowerCapacity);
    const energyTarget = powerTarget * catalog.constants.powerSpawnEnergyPerPower;
    const fills = [
      fillToTarget(structure.store, "energy", energyTarget),
      fillToTarget(structure.store, "power", powerTarget),
    ].filter((transfer): transfer is Transfer => transfer !== null);
    if (sumTransfers(fills) > structure.store.freeCapacity)
      return transferFailure("capacity-infeasible");
    transfers = fills;
  } else {
    const energyTarget = Math.min(objective.energyTarget, catalog.constants.nukerEnergyCapacity);
    const ghodiumTarget = Math.min(objective.ghodiumTarget, catalog.constants.nukerGhodiumCapacity);
    const fills = [
      fillToTarget(structure.store, "energy", energyTarget),
      fillToTarget(structure.store, "G", ghodiumTarget),
    ].filter((transfer): transfer is Transfer => transfer !== null);
    if (sumTransfers(fills) > structure.store.freeCapacity)
      return transferFailure("capacity-infeasible");
    transfers = fills;
  }
  if (transfers.some(({ amount }) => !positiveInteger(amount, limits.maximumAmountPerTransfer)))
    return transferFailure("invalid-objective");
  const fills = transfers.filter(({ mode }) => mode === "fill");
  if (
    fills.some(({ amount, resourceType }) => resourceAmount(endpointStore, resourceType) < amount)
  )
    return transferFailure("insufficient-stock");
  const drainAmount = sumTransfers(transfers.filter(({ mode }) => mode === "drain"));
  if (
    drainAmount > 0 &&
    (endpointStore.freeCapacity === null || endpointStore.freeCapacity < drainAmount)
  )
    return transferFailure("capacity-infeasible");
  return { reason: null, transfers: freeze([...transfers].sort(compareTransfers)) };
}

function projectTransfer(
  objective: MatureResourceObjective,
  structure: MatureStructureFact,
  endpoint: InventoryFact,
  transfer: Transfer,
  observedAt: number,
): {
  readonly edge: LogisticsEdge;
  readonly endpoint: LogisticsContractEndpoint;
  readonly node: LogisticsNode;
} {
  const fill = transfer.mode === "fill";
  const target = fill ? structure : endpoint;
  const sourceId = fill
    ? genericSourceNodeId(endpoint.id, transfer.resourceType)
    : genericSourceNodeId(structure.id, transfer.resourceType);
  const nodeId = `mature:${objective.id}:r${String(objective.revision)}:${transfer.mode}:${transfer.resourceType}`;
  const node = freeze({
    capacityReservationKey: aggregateStoreCapacityReservationKey(objective.colonyId, target.id),
    colonyId: objective.colonyId,
    freeCapacity: target.store.freeCapacity ?? 0,
    id: nodeId,
    kind: "sink" as const,
    observedAmount: 0,
    observedAt,
    position: freeze({ ...target.pos }),
    priority: freeze({ class: objective.priority, deadline: objective.deadline }),
    resourceType: transfer.resourceType,
  });
  const edge = freeze({
    budgetBinding: freeze({ category: "industry" as const, issuer: objective.industryBudgetId }),
    id: `mature-demand:${objective.id}:r${String(objective.revision)}:${transfer.mode}:${transfer.resourceType}`,
    maximumAmount: transfer.amount,
    roundTripTicks: roundTripTicks(fill ? endpoint.pos : structure.pos, target.pos),
    sinkNodeId: node.id,
    sourceNodeId: sourceId,
  });
  return {
    edge,
    endpoint: freeze({
      freeCapacity: node.freeCapacity,
      nodeId: node.id,
      observedAmount: 0,
      observedAt,
      position: node.position,
      resourceType: node.resourceType,
      targetId: target.id,
    }),
    node,
  };
}

interface InventoryFact {
  readonly active: boolean;
  readonly id: string;
  readonly pos: { readonly roomName: string; readonly x: number; readonly y: number };
  readonly store: StoreSnapshot;
}

function matureStructure(
  room: OwnedRoomSnapshot,
  objective: MatureResourceObjective,
): MatureStructureFact | undefined {
  const values: readonly (OwnedFactorySnapshot | OwnedNukerSnapshot | OwnedPowerSpawnSnapshot)[] =
    objective.kind === "factory-batch"
      ? (room.ownedFactories ?? [])
      : objective.kind === "power-processing"
        ? (room.ownedPowerSpawns ?? [])
        : (room.ownedNukers ?? []);
  const value = values.find(({ id }) => id === objective.structureId);
  if (value === undefined) return undefined;
  return {
    ...value,
    kind:
      objective.kind === "factory-batch"
        ? "factory"
        : objective.kind === "power-processing"
          ? "power-spawn"
          : "nuker",
  };
}

function inventoryEndpoint(room: OwnedRoomSnapshot, id: string): InventoryFact | undefined {
  return [...(room.ownedStorages ?? []), ...(room.ownedTerminals ?? [])].find(
    (value) => value.id === id,
  );
}

function fillToTarget(store: StoreSnapshot, resourceType: string, target: number): Transfer | null {
  const amount = Math.max(0, target - resourceAmount(store, resourceType));
  return amount === 0 ? null : { amount, mode: "fill", resourceType };
}

function transferFailure(reason: MatureResourceDemandBlockerReason): {
  readonly reason: MatureResourceDemandBlockerReason;
  readonly transfers: readonly Transfer[];
} {
  return { reason, transfers: [] };
}

function resourceAmount(store: StoreSnapshot, resourceType: string): number {
  return store.resources.find((resource) => resource.resourceType === resourceType)?.amount ?? 0;
}

function sumTransfers(transfers: readonly Transfer[]): number {
  return transfers.reduce((total, { amount }) => total + amount, 0);
}

function validObjective(
  objective: MatureResourceObjective,
  limits: MatureResourceDemandLimits,
): boolean {
  const base =
    identity(objective.id, 160) &&
    identity(objective.colonyId, 16) &&
    identity(objective.endpointId, 128) &&
    identity(objective.industryBudgetId, 160) &&
    identity(objective.mechanicsFingerprint, 160) &&
    identity(objective.structureId, 128) &&
    typeof objective.funded === "boolean" &&
    positiveInteger(objective.revision, Number.MAX_SAFE_INTEGER) &&
    nonnegativeInteger(objective.deadline);
  if (!base) return false;
  if (objective.kind === "factory-batch")
    return (
      identity(objective.product, 64) && positiveInteger(objective.batches, limits.maximumBatches)
    );
  if (objective.kind === "power-processing")
    return positiveInteger(objective.units, limits.maximumAmountPerTransfer);
  return (
    nonnegativeInteger(objective.energyTarget) &&
    objective.energyTarget <= limits.maximumAmountPerTransfer &&
    nonnegativeInteger(objective.ghodiumTarget) &&
    objective.ghodiumTarget <= limits.maximumAmountPerTransfer
  );
}

function validLimits(limits: MatureResourceDemandLimits): boolean {
  return (
    positiveInteger(limits.maximumAmountPerTransfer, 1_000_000) &&
    positiveInteger(limits.maximumBatches, 1_000) &&
    positiveInteger(limits.maximumEdges, 256) &&
    positiveInteger(limits.maximumNodes, 128) &&
    positiveInteger(limits.maximumObjectives, 128) &&
    positiveInteger(limits.maximumTransfersPerObjective, 64)
  );
}

function block(
  objective: MatureResourceObjective,
  reason: MatureResourceDemandBlockerReason,
  blockers: MatureResourceDemandBlocker[],
  dispositions: MatureResourceDemandDisposition[],
): void {
  blockers.push(freeze({ objectiveId: objective.id, reason, revision: objective.revision }));
  dispositions.push(disposition(objective, 0, 0, "blocked"));
}

function disposition(
  objective: MatureResourceObjective,
  projectedAmount: number,
  projectedTransfers: number,
  status: MatureResourceDemandDisposition["status"],
): MatureResourceDemandDisposition {
  return freeze({
    objectiveId: objective.id,
    projectedAmount,
    projectedTransfers,
    revision: objective.revision,
    status,
  });
}

function genericSourceNodeId(structureId: string, resourceType: string): string {
  return `store:${structureId}:source:${resourceType}`;
}

function roundTripTicks(
  source: { readonly roomName: string; readonly x: number; readonly y: number },
  sink: { readonly roomName: string; readonly x: number; readonly y: number },
): number {
  if (source.roomName !== sink.roomName) return 100;
  return Math.max(1, 2 * Math.max(Math.abs(source.x - sink.x), Math.abs(source.y - sink.y)));
}

function counts<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function compareObjectives(a: MatureResourceObjective, b: MatureResourceObjective): number {
  return compare(a.id, b.id) || a.revision - b.revision;
}

function compareTransfers(a: Transfer, b: Transfer): number {
  return compare(a.mode, b.mode) || compare(a.resourceType, b.resourceType);
}

function compareBlockers(a: MatureResourceDemandBlocker, b: MatureResourceDemandBlocker): number {
  return (
    compare(a.objectiveId, b.objectiveId) || a.revision - b.revision || compare(a.reason, b.reason)
  );
}

function compareDispositions(
  a: MatureResourceDemandDisposition,
  b: MatureResourceDemandDisposition,
): number {
  return compare(a.objectiveId, b.objectiveId) || a.revision - b.revision;
}

function identity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return nonnegativeInteger(value) && value > 0 && value <= maximum;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
