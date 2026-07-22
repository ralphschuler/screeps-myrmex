import type { BudgetRequest } from "../colony";
import {
  LAYOUT_STORAGE_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_RECORDS,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT,
  MAX_LAYOUT_STORAGE_EVACUATION_FLOWS,
  MAX_LAYOUT_STORAGE_RESOURCES,
  MAX_LAYOUT_TERMINAL_CAPACITY,
  layoutStorageEvacuationBudgetIssuer,
  layoutStorageEvacuationFlowId,
  type LayoutRecord,
  type LayoutStorageEvacuation,
} from "../layout";
import type { OwnedStorageSnapshot, OwnedTerminalSnapshot, WorldSnapshot } from "../world/snapshot";
import { aggregateStoreCapacityReservationKey } from "./planner";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutStorageEvacuationProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly demands: LogisticsResourceDemandProjection;
}

/** Projects one layout-owned bounded storage handoff into the sole logistics graph. */
export function projectLayoutStorageEvacuations(input: {
  readonly includeWork?: boolean;
  readonly existingBudgets: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly status: string;
  }[];
  readonly quiescentTerminalRoomNames: ReadonlySet<string>;
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): LayoutStorageEvacuationProjection {
  if (input.records.length > MAX_LAYOUT_RECORDS) return emptyProjection();
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedTargetIds: string[] = [];

  for (const record of [...input.records].sort((a, b) => compare(a.roomName, b.roomName))) {
    const evacuation = record.storageEvacuation;
    if (
      evacuation === undefined ||
      !validEvacuation(evacuation) ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    suppressedTargetIds.push(evacuation.sourceId, evacuation.terminalId);
    if (input.includeWork === false || !input.quiescentTerminalRoomNames.has(record.roomName))
      continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0
    )
      continue;
    const source = (room.ownedStorages ?? []).length === 1 ? room.ownedStorages?.[0] : undefined;
    const terminal =
      (room.ownedTerminals ?? []).length === 1 ? room.ownedTerminals?.[0] : undefined;
    if (
      source?.id !== evacuation.sourceId ||
      !source.active ||
      terminal?.id !== evacuation.terminalId ||
      !terminal.active
    )
      continue;
    const sourceStore = exactInventoryStore(source, MAX_LAYOUT_STORAGE_CAPACITY);
    const terminalStore = exactInventoryStore(terminal, MAX_LAYOUT_TERMINAL_CAPACITY);
    if (sourceStore === null || terminalStore === null) continue;
    if (
      [...sourceStore.resources].some(([resourceType]) => resourceType !== evacuation.resourceType)
    )
      continue;
    const sourceAmount = sourceStore.resources.get(evacuation.resourceType) ?? 0;
    const terminalAmount = terminalStore.resources.get(evacuation.resourceType) ?? 0;
    const delivered = terminalAmount - evacuation.terminalInitialAmount;
    const remaining = evacuation.amount - delivered;
    if (
      delivered < 0 ||
      delivered > evacuation.amount ||
      sourceAmount > remaining ||
      sourceAmount + delivered > evacuation.amount ||
      terminalStore.freeCapacity < remaining
    )
      continue;
    const flowId = layoutStorageEvacuationFlowId(room.name, evacuation);
    const issuer = layoutStorageEvacuationBudgetIssuer(room.name, evacuation);
    // Keep exact completed endpoints projected for one reconciliation tick so the sole Logistics
    // contract owner can retire the acquire/deliver contract before layout removal proceeds.
    if (flowId === null || issuer === null) continue;
    const sourceNodeId = `${flowId}:source:${evacuation.resourceType}`;
    const sinkNodeId = `${flowId}:sink:${evacuation.resourceType}`;
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
        resourceType: evacuation.resourceType,
      },
      {
        capacityReservationKey: aggregateStoreCapacityReservationKey(room.name, terminal.id),
        colonyId: room.name,
        freeCapacity: terminalStore.freeCapacity,
        id: sinkNodeId,
        kind: "sink",
        observedAmount: 0,
        observedAt: input.tick,
        position: terminal.pos,
        priority: { class: "normal", deadline: evacuation.expiresAt - 1 },
        resourceType: evacuation.resourceType,
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
        resourceType: evacuation.resourceType,
        targetId: source.id,
      },
      {
        freeCapacity: terminalStore.freeCapacity,
        nodeId: sinkNodeId,
        observedAmount: 0,
        observedAt: input.tick,
        position: terminal.pos,
        resourceType: evacuation.resourceType,
        targetId: terminal.id,
      },
    );
    edges.push({
      budgetBinding: { category: "optional-growth", issuer },
      id: flowId,
      maximumAmount: evacuation.amount,
      roundTripTicks: Math.max(
        1,
        Math.max(Math.abs(source.pos.x - terminal.pos.x), Math.abs(source.pos.y - terminal.pos.y)) *
          2,
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

  const ids = [...new Set(suppressedTargetIds)].sort(compare);
  const suppression = { suppressedSinkTargetIds: ids, suppressedSourceTargetIds: ids };
  if (
    edges.length > MAX_LAYOUT_STORAGE_EVACUATION_FLOWS ||
    budgets.length > MAX_LAYOUT_STORAGE_EVACUATION_FLOWS ||
    nodes.length > MAX_LAYOUT_STORAGE_EVACUATION_FLOWS * 2 ||
    endpoints.length > MAX_LAYOUT_STORAGE_EVACUATION_FLOWS * 2
  )
    return suppressionOnlyProjection(suppression);
  return freeze({ budgets, demands: { edges, endpoints, nodes, ...suppression } });
}

function validEvacuation(evacuation: LayoutStorageEvacuation): boolean {
  return (
    positiveInteger(evacuation.amount) &&
    evacuation.amount <= MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT &&
    nonnegativeInteger(evacuation.startedAt) &&
    nonnegativeInteger(evacuation.expiresAt) &&
    evacuation.expiresAt - evacuation.startedAt === LAYOUT_STORAGE_EVACUATION_TIMEOUT_TICKS &&
    identity(evacuation.resourceType, 64) &&
    evacuation.resourceType === evacuation.resourceType.trim() &&
    identity(evacuation.sourceId, 128) &&
    identity(evacuation.terminalId, 128) &&
    evacuation.sourceId !== evacuation.terminalId &&
    nonnegativeInteger(evacuation.terminalInitialAmount) &&
    evacuation.terminalInitialAmount + evacuation.amount <= MAX_LAYOUT_TERMINAL_CAPACITY
  );
}

function exactInventoryStore(
  structure: OwnedStorageSnapshot | OwnedTerminalSnapshot,
  expectedCapacity: number,
): { readonly freeCapacity: number; readonly resources: ReadonlyMap<string, number> } | null {
  const { store } = structure;
  if (
    store.capacity !== expectedCapacity ||
    store.freeCapacity === null ||
    !Number.isSafeInteger(store.freeCapacity) ||
    store.freeCapacity < 0 ||
    !Number.isSafeInteger(store.usedCapacity) ||
    store.usedCapacity < 0 ||
    store.freeCapacity + store.usedCapacity !== expectedCapacity ||
    store.resources.length > MAX_LAYOUT_STORAGE_RESOURCES
  )
    return null;
  const resources = new Map<string, number>();
  let used = 0;
  for (const { amount, resourceType } of store.resources) {
    if (
      resources.has(resourceType) ||
      !identity(resourceType, 64) ||
      resourceType !== resourceType.trim() ||
      !positiveInteger(amount)
    )
      return null;
    resources.set(resourceType, amount);
    used += amount;
  }
  return used === store.usedCapacity ? { freeCapacity: store.freeCapacity, resources } : null;
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

function suppressionOnlyProjection(input: {
  readonly suppressedSinkTargetIds: readonly string[];
  readonly suppressedSourceTargetIds: readonly string[];
}): LayoutStorageEvacuationProjection {
  return freeze({
    budgets: [],
    demands: { edges: [], endpoints: [], nodes: [], ...input },
  });
}
function emptyProjection(): LayoutStorageEvacuationProjection {
  return suppressionOnlyProjection({ suppressedSinkTargetIds: [], suppressedSourceTargetIds: [] });
}
function identity(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
