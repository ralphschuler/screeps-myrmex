import type { BudgetRequest } from "../colony";
import {
  LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS,
  MAX_LAYOUT_EXTENSION_ENERGY,
  MAX_LAYOUT_RECORDS,
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

/** Durable refill suppression for a persisted term, independent of optional-work authorization. */
export function projectLayoutExtensionEvacuationSuppressedSinkTargetIds(input: {
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): readonly string[] {
  if (input.records.length > MAX_LAYOUT_RECORDS) return Object.freeze([]);
  const suppressed = new Set<string>();
  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.extensionEvacuation;
    if (!isCurrentLayoutExtensionEvacuationTerm(evacuation, input.tick)) continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (room?.controller?.ownership !== "owned" || room.observedAt !== input.tick) continue;
    suppressed.add(evacuation.sourceId);
    const observedSources = room.ownedExtensions.filter(({ id }) => id === evacuation.sourceId);
    const observedSource = observedSources[0];
    const observedSourceEnergy =
      observedSources.length === 1 && observedSource !== undefined
        ? exactExtensionStoreEnergy(observedSource.store)
        : null;
    if (observedSourceEnergy === null || observedSourceEnergy > 0)
      suppressed.add(evacuation.replacementId);
  }
  return Object.freeze([...suppressed]);
}

/**
 * Fresh command-free completion evidence for an already-authorized extension evacuation. Contract
 * and endpoint retirement remain explicit inputs so Store deltas cannot settle active work.
 */
export function completedLayoutExtensionEvacuationRoomNames(input: {
  readonly activeFlowIds: ReadonlySet<string>;
  readonly activeTargetIds: ReadonlySet<string>;
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): readonly string[] {
  if (input.records.length > MAX_LAYOUT_RECORDS) return Object.freeze([]);
  const completed: string[] = [];
  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.extensionEvacuation;
    if (
      !isCurrentLayoutExtensionEvacuationTerm(evacuation, input.tick) ||
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
    const evidence = exactExtensionEvacuationEvidence(room.ownedExtensions, evacuation);
    if (
      evidence === null ||
      evidence.sourceEnergy !== 0 ||
      evidence.replacementEnergy !== evacuation.replacementInitialEnergy + evacuation.amount
    )
      continue;
    const { replacement, source } = evidence;
    const flowId = layoutExtensionEvacuationFlowId(room.name, evacuation);
    if (
      input.activeFlowIds.has(flowId) ||
      input.activeTargetIds.has(source.id) ||
      input.activeTargetIds.has(replacement.id)
    )
      continue;
    completed.push(room.name);
  }
  return Object.freeze(completed);
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
  if (input.records.length > MAX_LAYOUT_RECORDS) return emptyProjection();
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedSinkTargetIds = projectLayoutExtensionEvacuationSuppressedSinkTargetIds(input);

  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const evacuation = record.extensionEvacuation;
    if (!isCurrentLayoutExtensionEvacuationTerm(evacuation, input.tick)) continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0
    )
      continue;
    const evidence = exactExtensionEvacuationEvidence(room.ownedExtensions, evacuation);
    if (evidence === null) continue;
    const { replacement, source, sourceEnergy } = evidence;
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

function isCurrentLayoutExtensionEvacuationTerm(
  evacuation: LayoutRecord["extensionEvacuation"],
  tick: number,
): evacuation is NonNullable<LayoutRecord["extensionEvacuation"]> {
  return (
    evacuation !== undefined &&
    evacuation.amount > 0 &&
    evacuation.amount <= MAX_LAYOUT_EXTENSION_ENERGY &&
    evacuation.replacementInitialEnergy >= 0 &&
    evacuation.replacementInitialEnergy + evacuation.amount <= MAX_LAYOUT_EXTENSION_ENERGY &&
    evacuation.expiresAt - evacuation.startedAt === LAYOUT_EXTENSION_EVACUATION_TIMEOUT_TICKS &&
    tick < evacuation.expiresAt
  );
}

function exactExtensionEvacuationEvidence(
  extensions: WorldSnapshot["rooms"][number]["ownedExtensions"],
  evacuation: NonNullable<LayoutRecord["extensionEvacuation"]>,
): {
  readonly replacement: WorldSnapshot["rooms"][number]["ownedExtensions"][number];
  readonly replacementEnergy: number;
  readonly source: WorldSnapshot["rooms"][number]["ownedExtensions"][number];
  readonly sourceEnergy: number;
} | null {
  const sources = extensions.filter(({ id }) => id === evacuation.sourceId);
  const replacements = extensions.filter(({ id }) => id === evacuation.replacementId);
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
  const sourceCapacity = source.store.capacity;
  const replacementCapacity = replacement.store.capacity;
  const sourceEnergy = exactExtensionStoreEnergy(source.store);
  const replacementEnergy = exactExtensionStoreEnergy(replacement.store);
  if (
    sourceCapacity === null ||
    replacementCapacity === null ||
    sourceEnergy === null ||
    replacementEnergy === null ||
    sourceCapacity !== replacementCapacity ||
    evacuation.amount > sourceCapacity ||
    evacuation.replacementInitialEnergy + evacuation.amount > replacementCapacity ||
    sourceEnergy > evacuation.amount ||
    replacementEnergy < evacuation.replacementInitialEnergy ||
    sourceEnergy + replacementEnergy - evacuation.replacementInitialEnergy > evacuation.amount
  )
    return null;
  return { replacement, replacementEnergy, source, sourceEnergy };
}

function exactExtensionStoreEnergy(store: {
  readonly capacity: number | null;
  readonly freeCapacity: number | null;
  readonly resources: readonly { readonly amount: number; readonly resourceType: string }[];
  readonly usedCapacity: number;
}): number | null {
  if (
    store.capacity === null ||
    ![50, 100, MAX_LAYOUT_EXTENSION_ENERGY].includes(store.capacity) ||
    store.freeCapacity === null ||
    store.freeCapacity + store.usedCapacity !== store.capacity
  )
    return null;
  return exactEnergy(store);
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
