import type { BudgetRequest } from "../colony";
import {
  LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS,
  MAX_LAYOUT_CONTAINER_ENERGY,
  MAX_LAYOUT_CONTAINER_MIGRATION_FLOWS,
  MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES,
  MAX_LAYOUT_CONTAINER_STORE_RESOURCES,
  layoutContainerMigrationBudgetIssuer,
  layoutContainerMigrationFlowId,
  layoutContainerMigrationResourceBudgetIssuer,
  layoutContainerMigrationResourceFlowId,
  type LayoutContainerMigration,
  type LayoutRecord,
} from "../layout";
import type { StoredStructureSnapshot, WorldSnapshot } from "../world/snapshot";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutContainerMigrationProjection extends LogisticsResourceDemandProjection {
  readonly budgets: readonly BudgetRequest[];
}

interface ResourceTerm {
  readonly amount: number;
  readonly legacyEnergy: boolean;
  readonly replacementInitialAmount: number;
  readonly resourceType: string;
}

/** Projects one layout-owned general-container handoff into the sole logistics graph. */
export function projectLayoutContainerMigrations(input: {
  readonly existingBudgets?: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly status: string;
  }[];
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): LayoutContainerMigrationProjection {
  if (input.records.length > 64) return emptyProjection();
  const budgets: BudgetRequest[] = [];
  const edges: LogisticsResourceDemandProjection["edges"][number][] = [];
  const endpoints: LogisticsResourceDemandProjection["endpoints"][number][] = [];
  const nodes: LogisticsResourceDemandProjection["nodes"][number][] = [];
  const suppressedSinkTargetIds: string[] = [];
  const suppressedSourceTargetIds: string[] = [];

  for (const record of [...input.records].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const migration = record.containerMigration;
    if (
      migration === undefined ||
      migration.expiresAt - migration.startedAt !== LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS ||
      input.tick <= migration.startedAt ||
      input.tick >= migration.expiresAt
    )
      continue;
    const room = input.snapshot.rooms.find(({ name }) => name === record.roomName);
    if (
      room?.controller?.ownership !== "owned" ||
      room.observedAt !== input.tick ||
      room.hostileCreeps.length > 0
    )
      continue;
    const targets = room.storedStructures.filter(({ id }) => id === migration.targetId);
    const replacements = room.storedStructures.filter(({ id }) => id === migration.replacementId);
    if (targets.length !== 1 || replacements.length !== 1) continue;
    const target = targets[0];
    const replacement = replacements[0];
    if (
      target === undefined ||
      replacement === undefined ||
      !currentContainer(target) ||
      !currentContainer(replacement) ||
      target.id === replacement.id
    )
      continue;

    const terms = migrationTerms(migration);
    if (terms === null) continue;
    if (terms.length === 0) {
      if (emptyStore(target)) suppressedSinkTargetIds.push(target.id);
      continue;
    }
    const targetResources = exactResources(target);
    const replacementResources = exactResources(replacement);
    if (
      targetResources === null ||
      replacementResources === null ||
      replacement.store.freeCapacity === null ||
      replacement.store.freeCapacity < target.store.usedCapacity ||
      !currentResourcesMatchTerms(targetResources, replacementResources, terms)
    )
      continue;

    const projected = terms.map((term) => {
      const flowId = term.legacyEnergy
        ? layoutContainerMigrationFlowId(room.name, migration)
        : layoutContainerMigrationResourceFlowId(room.name, migration, term.resourceType);
      const issuer = term.legacyEnergy
        ? layoutContainerMigrationBudgetIssuer(room.name, migration)
        : layoutContainerMigrationResourceBudgetIssuer(room.name, migration, term.resourceType);
      return issuer === null || flowId === null ? null : { flowId, issuer, term };
    });
    if (projected.some((value) => value === null)) continue;

    for (const value of projected) {
      if (value === null) continue;
      const { flowId, issuer, term } = value;
      const targetAmount = targetResources.get(term.resourceType) ?? 0;
      const sourceNodeId = `${flowId}:source:${term.resourceType}`;
      const sinkNodeId = `${flowId}:sink:${term.resourceType}`;
      nodes.push(
        {
          colonyId: room.name,
          freeCapacity: 0,
          id: sourceNodeId,
          kind: "source",
          observedAmount: targetAmount,
          observedAt: input.tick,
          position: target.pos,
          priority: { class: "normal", deadline: migration.expiresAt - 1 },
          resourceType: term.resourceType,
        },
        {
          capacityReservationKey: `container:${room.name}:${replacement.id}:aggregate-capacity`,
          colonyId: room.name,
          freeCapacity: replacement.store.freeCapacity,
          id: sinkNodeId,
          kind: "sink",
          observedAmount: 0,
          observedAt: input.tick,
          position: replacement.pos,
          priority: { class: "normal", deadline: migration.expiresAt - 1 },
          resourceType: term.resourceType,
        },
      );
      endpoints.push(
        {
          acquireAction: "withdraw",
          freeCapacity: 0,
          nodeId: sourceNodeId,
          observedAmount: targetAmount,
          observedAt: input.tick,
          position: target.pos,
          resourceType: term.resourceType,
          targetId: target.id,
        },
        {
          freeCapacity: replacement.store.freeCapacity,
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
            Math.abs(target.pos.x - replacement.pos.x),
            Math.abs(target.pos.y - replacement.pos.y),
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
        expiresAt: migration.expiresAt,
        issuer,
        revision: renewedRevision(
          input.existingBudgets ?? [],
          room.name,
          issuer,
          migration.startedAt + 1,
        ),
        spawn: null,
      });
    }
    suppressedSinkTargetIds.push(target.id, replacement.id);
    suppressedSourceTargetIds.push(target.id);
  }

  if (
    edges.length > MAX_LAYOUT_CONTAINER_MIGRATION_FLOWS ||
    budgets.length > MAX_LAYOUT_CONTAINER_MIGRATION_FLOWS ||
    nodes.length > MAX_LAYOUT_CONTAINER_MIGRATION_FLOWS * 2 ||
    endpoints.length > MAX_LAYOUT_CONTAINER_MIGRATION_FLOWS * 2
  )
    return emptyProjection();
  return freeze({
    blockers: [],
    budgets,
    dispositions: [],
    edges,
    endpoints,
    nodes,
    suppressedSinkTargetIds: [...new Set(suppressedSinkTargetIds)].sort(),
    suppressedSourceTargetIds: [...new Set(suppressedSourceTargetIds)].sort(),
  });
}

function migrationTerms(migration: LayoutContainerMigration): readonly ResourceTerm[] | null {
  const manifest = migration.resourceManifest;
  const hasEnergy = migration.energyAmount !== undefined;
  const hasEnergyBaseline = migration.replacementInitialEnergy !== undefined;
  if (manifest !== undefined) {
    if (
      hasEnergy ||
      hasEnergyBaseline ||
      manifest.length < 2 ||
      manifest.length > MAX_LAYOUT_CONTAINER_MIGRATION_RESOURCES
    )
      return null;
    let prior = "";
    let amountTotal = 0;
    let replacementTotal = 0;
    const terms: ResourceTerm[] = [];
    for (const row of manifest) {
      if (
        !Array.isArray(row) ||
        !identity(row[0], 64) ||
        (prior !== "" && compare(prior, row[0]) >= 0) ||
        !positiveInteger(row[1]) ||
        !nonnegativeInteger(row[2])
      )
        return null;
      prior = row[0];
      amountTotal += row[1];
      replacementTotal += row[2];
      terms.push({
        amount: row[1],
        legacyEnergy: false,
        replacementInitialAmount: row[2],
        resourceType: row[0],
      });
    }
    return amountTotal <= MAX_LAYOUT_CONTAINER_ENERGY &&
      replacementTotal + amountTotal <= MAX_LAYOUT_CONTAINER_ENERGY
      ? terms
      : null;
  }
  if (!hasEnergy && !hasEnergyBaseline) return [];
  if (
    !positiveInteger(migration.energyAmount) ||
    migration.energyAmount > MAX_LAYOUT_CONTAINER_ENERGY ||
    !nonnegativeInteger(migration.replacementInitialEnergy) ||
    migration.replacementInitialEnergy + migration.energyAmount > MAX_LAYOUT_CONTAINER_ENERGY
  )
    return null;
  return [
    {
      amount: migration.energyAmount,
      legacyEnergy: true,
      replacementInitialAmount: migration.replacementInitialEnergy,
      resourceType: "energy",
    },
  ];
}

function exactResources(structure: StoredStructureSnapshot): ReadonlyMap<string, number> | null {
  if (
    structure.store.capacity !== MAX_LAYOUT_CONTAINER_ENERGY ||
    !nonnegativeInteger(structure.store.usedCapacity) ||
    structure.store.usedCapacity > MAX_LAYOUT_CONTAINER_ENERGY ||
    !nonnegativeInteger(structure.store.freeCapacity) ||
    structure.store.usedCapacity + structure.store.freeCapacity !== MAX_LAYOUT_CONTAINER_ENERGY ||
    structure.store.resources.length > MAX_LAYOUT_CONTAINER_STORE_RESOURCES
  )
    return null;
  const resources = [...structure.store.resources].sort((left, right) =>
    compare(left.resourceType, right.resourceType),
  );
  if (
    resources.some(
      ({ amount, resourceType }) => !identity(resourceType, 64) || !positiveInteger(amount),
    ) ||
    new Set(resources.map(({ resourceType }) => resourceType)).size !== resources.length ||
    resources.reduce((total, { amount }) => total + amount, 0) !== structure.store.usedCapacity
  )
    return null;
  return new Map(resources.map(({ amount, resourceType }) => [resourceType, amount]));
}

function currentResourcesMatchTerms(
  target: ReadonlyMap<string, number>,
  replacement: ReadonlyMap<string, number>,
  terms: readonly ResourceTerm[],
): boolean {
  const termsByResource = new Map(terms.map((term) => [term.resourceType, term]));
  for (const [resourceType, amount] of target) {
    const term = termsByResource.get(resourceType);
    if (term === undefined || amount > term.amount) return false;
  }
  return terms.every(
    ({ replacementInitialAmount, resourceType }) =>
      (replacement.get(resourceType) ?? 0) >= replacementInitialAmount,
  );
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

function currentContainer(structure: StoredStructureSnapshot): boolean {
  return structure.structureType === "container" && structure.ownership !== "foreign";
}
function emptyStore(structure: StoredStructureSnapshot): boolean {
  return (
    structure.store.usedCapacity === 0 &&
    structure.store.resources.every(({ amount }) => amount === 0)
  );
}
function identity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
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
function emptyProjection(): LayoutContainerMigrationProjection {
  return freeze({
    blockers: [],
    budgets: [],
    dispositions: [],
    edges: [],
    endpoints: [],
    nodes: [],
    suppressedSinkTargetIds: [],
    suppressedSourceTargetIds: [],
  });
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
