import type { BudgetRequest } from "../colony";
import {
  LAYOUT_STORAGE_EVACUATION_TIMEOUT_TICKS,
  LAYOUT_STORAGE_SEQUENTIAL_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_RECORDS,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT,
  MAX_LAYOUT_STORAGE_EVACUATION_FLOWS,
  MAX_LAYOUT_STORAGE_EVACUATION_RESOURCES,
  MAX_LAYOUT_STORAGE_RESOURCES,
  MAX_LAYOUT_STORAGE_SEQUENTIAL_EVACUATION_AMOUNT,
  MAX_LAYOUT_TERMINAL_CAPACITY,
  layoutStorageEvacuationBudgetIssuers,
  layoutStorageEvacuationCurrentBatchResources,
  layoutStorageEvacuationFlowIds,
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

interface ResourceTerm {
  readonly amount: number;
  readonly deferredAmount: number;
  readonly resourceType: string;
  readonly terminalInitialAmount: number;
  readonly totalAmount: number;
  readonly totalTerminalInitialAmount: number;
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
      !validEvacuationCommon(evacuation) ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    const terms = storageEvacuationTerms(evacuation);
    if (terms === null) continue;
    // Both physical Stores remain durably suppressed even when current drift, CPU admission, or a
    // bounded overflow prevents optional evacuation work from entering the logistics graph.
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
    const termResources = new Set(terms.map(({ resourceType }) => resourceType));
    if ([...sourceStore.resources].some(([resourceType]) => !termResources.has(resourceType)))
      continue;

    const current = terms.map((term) => {
      const observedSourceAmount = sourceStore.resources.get(term.resourceType) ?? 0;
      const terminalAmount = terminalStore.resources.get(term.resourceType) ?? 0;
      const delivered = terminalAmount - term.terminalInitialAmount;
      const totalDelivered = terminalAmount - term.totalTerminalInitialAmount;
      const remaining = term.amount - delivered;
      const sourceAmount = observedSourceAmount - term.deferredAmount;
      return {
        delivered,
        observedSourceAmount,
        remaining,
        sourceAmount,
        term,
        totalDelivered,
        workRemaining: sourceAmount > 0 || remaining > 0,
      };
    });
    // Endpoint shortfall may be resource currently carried by the one Logistics contract. Exact
    // endpoint conservation is required before cursor advancement or removal; overage is always drift.
    if (
      current.some(
        ({ delivered, observedSourceAmount, sourceAmount, term, totalDelivered }) =>
          delivered < 0 ||
          delivered > term.amount ||
          totalDelivered < 0 ||
          totalDelivered > term.totalAmount ||
          sourceAmount < 0 ||
          sourceAmount > term.amount - delivered ||
          observedSourceAmount + totalDelivered > term.totalAmount,
      ) ||
      terminalStore.freeCapacity <
        current.reduce(
          (total, { term, totalDelivered }) => total + term.totalAmount - totalDelivered,
          0,
        )
    )
      continue;

    const flowIds = layoutStorageEvacuationFlowIds(room.name, evacuation);
    const issuers = layoutStorageEvacuationBudgetIssuers(room.name, evacuation);
    const currentBatch = current.filter(({ term }) => term.amount > 0);
    if (
      flowIds === null ||
      issuers === null ||
      flowIds.length !== currentBatch.length ||
      issuers.length !== currentBatch.length ||
      new Set(flowIds).size !== flowIds.length ||
      new Set(issuers).size !== issuers.length
    )
      continue;
    const manifest = "resourceManifest" in evacuation;

    for (let index = 0; index < currentBatch.length; index += 1) {
      const item = currentBatch[index];
      const flowId = flowIds[index];
      const issuer = issuers[index];
      if (
        item === undefined ||
        flowId === undefined ||
        issuer === undefined ||
        (!item.workRemaining && manifest)
      )
        continue;
      const { sourceAmount, term } = item;
      const sourceNodeId = `${flowId}:source:${term.resourceType}`;
      const sinkNodeId = `${flowId}:sink:${term.resourceType}`;
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
          resourceType: term.resourceType,
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
          resourceType: term.resourceType,
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
          resourceType: term.resourceType,
          targetId: source.id,
        },
        {
          freeCapacity: terminalStore.freeCapacity,
          nodeId: sinkNodeId,
          observedAmount: 0,
          observedAt: input.tick,
          position: terminal.pos,
          resourceType: term.resourceType,
          targetId: terminal.id,
        },
      );
      edges.push({
        budgetBinding: { category: "optional-growth", issuer },
        id: flowId,
        maximumAmount: term.amount,
        roundTripTicks: Math.max(
          1,
          Math.max(
            Math.abs(source.pos.x - terminal.pos.x),
            Math.abs(source.pos.y - terminal.pos.y),
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
        revision: renewedRevision(
          input.existingBudgets,
          room.name,
          issuer,
          evacuation.startedAt + 1,
        ),
        spawn: null,
      });
    }
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

/** Keeps every currently projected row of one storage manifest atomic. */
export function completeExecutableLayoutStorageEvacuationFlowIds(input: {
  readonly executableFlowIds: ReadonlySet<string>;
  readonly projectedFlowIds: ReadonlySet<string>;
  readonly records: readonly LayoutRecord[];
}): ReadonlySet<string> {
  const complete = new Set<string>();
  for (const record of input.records) {
    if (record.storageEvacuation === undefined) continue;
    const flowIds = layoutStorageEvacuationFlowIds(record.roomName, record.storageEvacuation);
    if (flowIds === null) continue;
    const projected = flowIds.filter((flowId) => input.projectedFlowIds.has(flowId));
    if (projected.length > 0 && projected.every((flowId) => input.executableFlowIds.has(flowId))) {
      for (const flowId of projected) complete.add(flowId);
    }
  }
  return complete;
}

/** Requires the complete current storage-manifest subset to pass both Logistics and colony funding. */
export function authorizeLayoutStorageEvacuationFlowIds(input: {
  readonly fundedFlowIds: ReadonlySet<string>;
  readonly logisticsExecutableFlowIds: ReadonlySet<string>;
  readonly projectedFlowIds: ReadonlySet<string>;
  readonly records: readonly LayoutRecord[];
}): ReadonlySet<string> {
  const executable = new Set(
    [...input.logisticsExecutableFlowIds].filter((flowId) => input.fundedFlowIds.has(flowId)),
  );
  return completeExecutableLayoutStorageEvacuationFlowIds({
    executableFlowIds: executable,
    projectedFlowIds: input.projectedFlowIds,
    records: input.records,
  });
}

function validEvacuationCommon(evacuation: LayoutStorageEvacuation): boolean {
  const sequential = "settledAmount" in evacuation;
  return (
    nonnegativeInteger(evacuation.startedAt) &&
    nonnegativeInteger(evacuation.expiresAt) &&
    evacuation.expiresAt - evacuation.startedAt ===
      (sequential
        ? LAYOUT_STORAGE_SEQUENTIAL_EVACUATION_TIMEOUT_TICKS
        : LAYOUT_STORAGE_EVACUATION_TIMEOUT_TICKS) &&
    identity(evacuation.sourceId, 128) &&
    identity(evacuation.terminalId, 128) &&
    evacuation.sourceId !== evacuation.terminalId
  );
}

function storageEvacuationTerms(
  evacuation: LayoutStorageEvacuation,
): readonly ResourceTerm[] | null {
  const raw = evacuation as unknown as Record<string, unknown>;
  const originals: {
    readonly amount: number;
    readonly resourceType: string;
    readonly terminalInitialAmount: number;
  }[] = [];
  const manifest = raw.resourceManifest;
  if (manifest !== undefined) {
    if (
      raw.amount !== undefined ||
      raw.resourceType !== undefined ||
      raw.terminalInitialAmount !== undefined ||
      !Array.isArray(manifest) ||
      manifest.length < 2 ||
      manifest.length > MAX_LAYOUT_STORAGE_EVACUATION_RESOURCES
    )
      return null;
    let prior = "";
    for (const row of manifest) {
      if (!Array.isArray(row) || row.length !== 3) return null;
      const resourceType: unknown = row[0];
      const amount: unknown = row[1];
      const terminalInitialAmount: unknown = row[2];
      if (
        !identity(resourceType, 64) ||
        resourceType !== resourceType.trim() ||
        (prior !== "" && compare(prior, resourceType) >= 0) ||
        !positiveInteger(amount) ||
        !nonnegativeInteger(terminalInitialAmount)
      )
        return null;
      prior = resourceType;
      originals.push({ amount, resourceType, terminalInitialAmount });
    }
  } else {
    if (
      !positiveInteger(raw.amount) ||
      !identity(raw.resourceType, 64) ||
      raw.resourceType !== raw.resourceType.trim() ||
      !nonnegativeInteger(raw.terminalInitialAmount)
    )
      return null;
    originals.push({
      amount: raw.amount,
      resourceType: raw.resourceType,
      terminalInitialAmount: raw.terminalInitialAmount,
    });
  }

  const totalAmount = originals.reduce((total, term) => total + term.amount, 0);
  const terminalTotal = originals.reduce((total, term) => total + term.terminalInitialAmount, 0);
  const settledAmount = raw.settledAmount;
  if (settledAmount === undefined) {
    if (totalAmount > MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT) return null;
  } else if (
    (settledAmount !== 0 && settledAmount !== MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT) ||
    totalAmount <= MAX_LAYOUT_STORAGE_EVACUATION_AMOUNT ||
    totalAmount > MAX_LAYOUT_STORAGE_SEQUENTIAL_EVACUATION_AMOUNT ||
    settledAmount >= totalAmount
  )
    return null;
  if (terminalTotal + totalAmount > MAX_LAYOUT_TERMINAL_CAPACITY) return null;

  const currentResources = layoutStorageEvacuationCurrentBatchResources(evacuation);
  const currentByResource = new Map(
    currentResources.map(([resourceType, amount, terminalInitialAmount]) => [
      resourceType,
      { amount, terminalInitialAmount },
    ]),
  );
  if (
    currentByResource.size !== currentResources.length ||
    currentResources.length === 0 ||
    [...currentByResource.keys()].some(
      (resourceType) => !originals.some((term) => term.resourceType === resourceType),
    )
  )
    return null;

  const terms: ResourceTerm[] = [];
  let resourceStart = 0;
  for (const original of originals) {
    const priorAmount =
      settledAmount === undefined
        ? 0
        : Math.max(0, Math.min(original.amount, settledAmount - resourceStart));
    const current = currentByResource.get(original.resourceType);
    const amount = current?.amount ?? 0;
    if (
      amount < 0 ||
      priorAmount + amount > original.amount ||
      (current !== undefined &&
        current.terminalInitialAmount !== original.terminalInitialAmount + priorAmount)
    )
      return null;
    terms.push({
      amount,
      deferredAmount: original.amount - priorAmount - amount,
      resourceType: original.resourceType,
      terminalInitialAmount: original.terminalInitialAmount + priorAmount,
      totalAmount: original.amount,
      totalTerminalInitialAmount: original.terminalInitialAmount,
    });
    resourceStart += original.amount;
  }
  return terms;
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
