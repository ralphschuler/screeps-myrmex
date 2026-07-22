import type { BudgetRequest } from "../colony";
import {
  LAYOUT_TERMINAL_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_RECORDS,
  MAX_LAYOUT_STORAGE_CAPACITY,
  MAX_LAYOUT_STORAGE_RESOURCES,
  MAX_LAYOUT_TERMINAL_CAPACITY,
  MAX_LAYOUT_TERMINAL_EVACUATION_AMOUNT,
  MAX_LAYOUT_TERMINAL_EVACUATION_FLOWS,
  MAX_LAYOUT_TERMINAL_EVACUATION_RESOURCES,
  layoutTerminalEvacuationBudgetIssuers,
  layoutTerminalEvacuationFlowIds,
  type LayoutRecord,
  type LayoutTerminalEvacuation,
} from "../layout";
import type { OwnedStorageSnapshot, OwnedTerminalSnapshot, WorldSnapshot } from "../world/snapshot";
import { aggregateStoreCapacityReservationKey } from "./planner";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutTerminalEvacuationProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly demands: LogisticsResourceDemandProjection;
}

interface ResourceTerm {
  readonly amount: number;
  readonly replacementInitialAmount: number;
  readonly resourceType: string;
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

  for (const record of [...input.records].sort((a, b) => compare(a.roomName, b.roomName))) {
    const evacuation = record.terminalEvacuation;
    if (
      evacuation === undefined ||
      evacuation.expiresAt - evacuation.startedAt !== LAYOUT_TERMINAL_EVACUATION_TIMEOUT_TICKS ||
      input.tick <= evacuation.startedAt ||
      input.tick >= evacuation.expiresAt
    )
      continue;
    const terms = terminalEvacuationTerms(evacuation);
    if (terms === null) continue;
    // Durable suppression is safety evidence, not optional flow admission. Keep the obsolete
    // terminal out of ordinary logistics when current drift or a bounded overflow blocks work.
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
    const termResources = new Set(terms.map(({ resourceType }) => resourceType));
    if ([...sourceStore.resources].some(([resourceType]) => !termResources.has(resourceType)))
      continue;

    const current = terms.map((term) => {
      const sourceAmount = sourceStore.resources.get(term.resourceType) ?? 0;
      const replacementAmount = replacementStore.resources.get(term.resourceType) ?? 0;
      const delivered = replacementAmount - term.replacementInitialAmount;
      const remaining = term.amount - delivered;
      return {
        delivered,
        remaining,
        sourceAmount,
        term,
        workRemaining: sourceAmount > 0 || remaining > 0,
      };
    });
    if (
      current.some(
        ({ delivered, remaining, sourceAmount, term }) =>
          delivered < 0 ||
          delivered > term.amount ||
          sourceAmount > remaining ||
          sourceAmount + delivered > term.amount,
      ) ||
      replacementStore.freeCapacity <
        current.reduce(
          (total, { remaining, sourceAmount }) => total + Math.max(sourceAmount, remaining),
          0,
        )
    )
      continue;

    const flowIds = layoutTerminalEvacuationFlowIds(room.name, evacuation);
    const issuers = layoutTerminalEvacuationBudgetIssuers(room.name, evacuation);
    if (
      flowIds === null ||
      issuers === null ||
      flowIds.length !== terms.length ||
      issuers.length !== terms.length ||
      new Set(flowIds).size !== flowIds.length ||
      new Set(issuers).size !== issuers.length
    )
      continue;

    for (let index = 0; index < current.length; index += 1) {
      const item = current[index];
      const flowId = flowIds[index];
      const issuer = issuers[index];
      if (item === undefined || flowId === undefined || issuer === undefined || !item.workRemaining)
        continue;
      const { term, sourceAmount } = item;
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
          capacityReservationKey: aggregateStoreCapacityReservationKey(room.name, replacement.id),
          colonyId: room.name,
          freeCapacity: replacementStore.freeCapacity,
          id: sinkNodeId,
          kind: "sink",
          observedAmount: 0,
          observedAt: input.tick,
          position: replacement.pos,
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
          freeCapacity: replacementStore.freeCapacity,
          nodeId: sinkNodeId,
          observedAmount: 0,
          observedAt: input.tick,
          position: replacement.pos,
          resourceType: term.resourceType,
          targetId: replacement.id,
        },
      );
      edges.push({
        budgetBinding: { category: "optional-growth", issuer },
        id: flowId,
        maximumAmount: term.amount,
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

  const suppression = {
    suppressedSinkTargetIds: [...new Set(suppressedSinkTargetIds)].sort(compare),
    suppressedSourceTargetIds: [...new Set(suppressedSourceTargetIds)].sort(compare),
  };
  if (
    edges.length > MAX_LAYOUT_TERMINAL_EVACUATION_FLOWS ||
    budgets.length > MAX_LAYOUT_TERMINAL_EVACUATION_FLOWS ||
    nodes.length > MAX_LAYOUT_TERMINAL_EVACUATION_FLOWS * 2 ||
    endpoints.length > MAX_LAYOUT_TERMINAL_EVACUATION_FLOWS * 2
  )
    return suppressionOnlyProjection(suppression);
  return freeze({
    budgets,
    demands: {
      edges,
      endpoints,
      nodes,
      ...suppression,
    },
  });
}

/** Keeps every currently projected row of one terminal manifest atomic. */
export function completeExecutableLayoutTerminalEvacuationFlowIds(input: {
  readonly executableFlowIds: ReadonlySet<string>;
  readonly projectedFlowIds: ReadonlySet<string>;
  readonly records: readonly LayoutRecord[];
}): ReadonlySet<string> {
  const complete = new Set<string>();
  for (const record of input.records) {
    if (record.terminalEvacuation === undefined) continue;
    const flowIds = layoutTerminalEvacuationFlowIds(record.roomName, record.terminalEvacuation);
    if (flowIds === null) continue;
    const projected = flowIds.filter((flowId) => input.projectedFlowIds.has(flowId));
    if (projected.length > 0 && projected.every((flowId) => input.executableFlowIds.has(flowId))) {
      for (const flowId of projected) complete.add(flowId);
    }
  }
  return complete;
}

function terminalEvacuationTerms(
  evacuation: LayoutTerminalEvacuation,
): readonly ResourceTerm[] | null {
  const raw = evacuation as unknown as Record<string, unknown>;
  const manifest = raw.resourceManifest;
  if (manifest !== undefined) {
    if (
      raw.amount !== undefined ||
      raw.replacementInitialAmount !== undefined ||
      raw.resourceType !== undefined ||
      !Array.isArray(manifest) ||
      manifest.length < 2 ||
      manifest.length > MAX_LAYOUT_TERMINAL_EVACUATION_RESOURCES
    )
      return null;
    let prior = "";
    let amountTotal = 0;
    let replacementTotal = 0;
    const terms: ResourceTerm[] = [];
    for (const row of manifest) {
      if (!Array.isArray(row) || row.length !== 3) return null;
      const resourceType: unknown = row[0];
      const amount: unknown = row[1];
      const replacementInitialAmount: unknown = row[2];
      if (
        !identity(resourceType, 64) ||
        resourceType !== resourceType.trim() ||
        (prior !== "" && compare(prior, resourceType) >= 0) ||
        !positiveInteger(amount) ||
        !nonnegativeInteger(replacementInitialAmount)
      )
        return null;
      prior = resourceType;
      amountTotal += amount;
      replacementTotal += replacementInitialAmount;
      terms.push({ amount, replacementInitialAmount, resourceType });
    }
    return amountTotal <= MAX_LAYOUT_TERMINAL_EVACUATION_AMOUNT &&
      replacementTotal + amountTotal <= MAX_LAYOUT_STORAGE_CAPACITY
      ? terms
      : null;
  }
  if (
    !positiveInteger(raw.amount) ||
    raw.amount > MAX_LAYOUT_TERMINAL_EVACUATION_AMOUNT ||
    !nonnegativeInteger(raw.replacementInitialAmount) ||
    raw.replacementInitialAmount + raw.amount > MAX_LAYOUT_STORAGE_CAPACITY ||
    !identity(raw.resourceType, 64) ||
    raw.resourceType !== raw.resourceType.trim()
  )
    return null;
  return [
    {
      amount: raw.amount,
      replacementInitialAmount: raw.replacementInitialAmount,
      resourceType: raw.resourceType,
    },
  ];
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
}): LayoutTerminalEvacuationProjection {
  return freeze({
    budgets: [],
    demands: {
      edges: [],
      endpoints: [],
      nodes: [],
      ...input,
    },
  });
}

function emptyProjection(): LayoutTerminalEvacuationProjection {
  return suppressionOnlyProjection({ suppressedSinkTargetIds: [], suppressedSourceTargetIds: [] });
}

function identity(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
