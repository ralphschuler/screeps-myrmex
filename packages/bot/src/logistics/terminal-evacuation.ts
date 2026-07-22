import type { BudgetRequest } from "../colony";
import {
  LAYOUT_TERMINAL_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_RECORDS,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_STORAGE_RESOURCES,
  MAX_LAYOUT_TERMINAL_CAPACITY,
  MAX_LAYOUT_TERMINAL_EVACUATION_AMOUNT,
  layoutTerminalEvacuationBudgetIssuer,
  layoutTerminalEvacuationFlowId,
  type LayoutRecord,
} from "../layout";
import type { OwnedStorageSnapshot, OwnedTerminalSnapshot, WorldSnapshot } from "../world/snapshot";
import { aggregateStoreCapacityReservationKey } from "./planner";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutTerminalEvacuationProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly demands: LogisticsResourceDemandProjection;
}

/** Projects one layout-owned terminal stock handoff into the sole logistics graph. */
export function projectLayoutTerminalEvacuations(input: {
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
}): LayoutTerminalEvacuationProjection {
  if (input.records.length > MAX_LAYOUT_RECORDS) return emptyProjection();
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedSinkTargetIds: string[] = [];
  const suppressedSourceTargetIds: string[] = [];

  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.terminalEvacuation;
    if (
      evacuation === undefined ||
      evacuation.amount <= 0 ||
      evacuation.amount > MAX_LAYOUT_TERMINAL_EVACUATION_AMOUNT ||
      evacuation.expiresAt - evacuation.startedAt !== LAYOUT_TERMINAL_EVACUATION_TIMEOUT_TICKS ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    // Durable suppression is safety evidence, not optional flow admission. Keep the obsolete
    // terminal out of ordinary logistics when current drift blocks an active evacuation.
    suppressedSinkTargetIds.push(evacuation.sourceId);
    suppressedSourceTargetIds.push(evacuation.sourceId);
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0
    )
      continue;
    const terminals = room.ownedTerminals ?? [];
    const storages = room.ownedStorages ?? [];
    const source = terminals.length === 1 ? terminals[0] : undefined;
    const replacement = storages.length === 1 ? storages[0] : undefined;
    if (
      source?.id !== evacuation.sourceId ||
      !source.active ||
      source.cooldown !== 0 ||
      replacement?.id !== evacuation.replacementId ||
      !replacement.active
    )
      continue;
    const sourceStore = exactInventoryStore(source, MAX_LAYOUT_TERMINAL_CAPACITY);
    const replacementStore = exactInventoryStore(replacement, MAX_LAYOUT_STORAGE_CAPACITY);
    if (sourceStore === null || replacementStore === null) continue;
    const sourceAmount = sourceStore.resources.get(evacuation.resourceType) ?? 0;
    const replacementAmount = replacementStore.resources.get(evacuation.resourceType) ?? 0;
    const delivered = replacementAmount - evacuation.replacementInitialAmount;
    const remaining = evacuation.amount - delivered;
    if (
      sourceStore.resources.size > Number(sourceAmount > 0) ||
      delivered < 0 ||
      delivered > evacuation.amount ||
      sourceAmount > remaining ||
      replacementStore.freeCapacity < remaining
    )
      continue;
    const flowId = layoutTerminalEvacuationFlowId(room.name, evacuation);
    const issuer = layoutTerminalEvacuationBudgetIssuer(room.name, evacuation);
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
        capacityReservationKey: aggregateStoreCapacityReservationKey(room.name, replacement.id),
        colonyId: room.name,
        freeCapacity: replacementStore.freeCapacity,
        id: sinkNodeId,
        kind: "sink",
        observedAmount: 0,
        observedAt: input.tick,
        position: replacement.pos,
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
        freeCapacity: replacementStore.freeCapacity,
        nodeId: sinkNodeId,
        observedAmount: 0,
        observedAt: input.tick,
        position: replacement.pos,
        resourceType: evacuation.resourceType,
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
    demands: {
      edges,
      endpoints,
      nodes,
      suppressedSinkTargetIds,
      suppressedSourceTargetIds,
    },
  });
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

function emptyProjection(): LayoutTerminalEvacuationProjection {
  return freeze({
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
