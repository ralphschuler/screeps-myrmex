import type { BudgetRequest } from "../colony";
import {
  LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS,
  MAX_LAYOUT_CONTAINER_ENERGY,
  layoutContainerMigrationBudgetIssuer,
  layoutContainerMigrationFlowId,
  type LayoutRecord,
} from "../layout";
import type { StoredStructureSnapshot, WorldSnapshot } from "../world/snapshot";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

export interface LayoutContainerMigrationProjection extends LogisticsResourceDemandProjection {
  readonly budgets: readonly BudgetRequest[];
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

    const energyAmount = migration.energyAmount;
    const replacementInitialEnergy = migration.replacementInitialEnergy;
    if (energyAmount === undefined && replacementInitialEnergy === undefined) {
      if (emptyStore(target)) suppressedSinkTargetIds.push(target.id);
      continue;
    }
    if (
      !positiveInteger(energyAmount) ||
      energyAmount > MAX_LAYOUT_CONTAINER_ENERGY ||
      !nonnegativeInteger(replacementInitialEnergy) ||
      replacementInitialEnergy + energyAmount > MAX_LAYOUT_CONTAINER_ENERGY
    )
      continue;
    const targetEnergy = exactEnergy(target);
    const replacementEnergy = exactEnergy(replacement);
    if (
      targetEnergy === null ||
      replacementEnergy === null ||
      targetEnergy > energyAmount ||
      replacementEnergy < replacementInitialEnergy ||
      replacement.store.freeCapacity === null
    )
      continue;
    const flowId = layoutContainerMigrationFlowId(room.name, migration);
    const issuer = layoutContainerMigrationBudgetIssuer(room.name, migration);
    if (issuer === null) continue;
    const sourceNodeId = `${flowId}:source:energy`;
    const sinkNodeId = `${flowId}:sink:energy`;
    nodes.push(
      {
        colonyId: room.name,
        freeCapacity: 0,
        id: sourceNodeId,
        kind: "source",
        observedAmount: targetEnergy,
        observedAt: input.tick,
        position: target.pos,
        priority: { class: "normal", deadline: migration.expiresAt - 1 },
        resourceType: "energy",
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
        resourceType: "energy",
      },
    );
    endpoints.push(
      {
        acquireAction: "withdraw",
        freeCapacity: 0,
        nodeId: sourceNodeId,
        observedAmount: targetEnergy,
        observedAt: input.tick,
        position: target.pos,
        resourceType: "energy",
        targetId: target.id,
      },
      {
        freeCapacity: replacement.store.freeCapacity,
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
      maximumAmount: energyAmount,
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
    suppressedSinkTargetIds.push(target.id, replacement.id);
    suppressedSourceTargetIds.push(target.id);
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
function exactEnergy(structure: StoredStructureSnapshot): number | null {
  const energy = structure.store.resources
    .filter(({ resourceType }) => resourceType === "energy")
    .reduce((total, resource) => total + resource.amount, 0);
  return Number.isSafeInteger(energy) &&
    energy >= 0 &&
    energy <= MAX_LAYOUT_CONTAINER_ENERGY &&
    energy === structure.store.usedCapacity &&
    structure.store.resources.every(
      ({ amount, resourceType }) => amount >= 0 && (amount === 0 || resourceType === "energy"),
    )
    ? energy
    : null;
}
function emptyStore(structure: StoredStructureSnapshot): boolean {
  return (
    structure.store.usedCapacity === 0 &&
    structure.store.resources.every(({ amount }) => amount === 0)
  );
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
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
