import { LAYOUT_CONTAINER_MIGRATION_TIMEOUT_TICKS, type LayoutRecord } from "../layout";
import type { StoredStructureSnapshot, WorldSnapshot } from "../world/snapshot";
import type { LogisticsResourceDemandProjection } from "./resource-demands";

/** Suppresses ordinary refill while a layout-owned empty general container awaits safe removal. */
export function projectLayoutContainerMigrations(input: {
  readonly records: readonly LayoutRecord[];
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}): LogisticsResourceDemandProjection {
  if (input.records.length > 64) return emptyProjection();
  const suppressedSinkTargetIds: string[] = [];
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
    if (room?.controller?.ownership !== "owned" || room.observedAt !== input.tick) continue;
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
      target.id === replacement.id ||
      !emptyStore(target)
    )
      continue;
    suppressedSinkTargetIds.push(target.id);
  }
  return freeze({
    blockers: [],
    dispositions: [],
    edges: [],
    endpoints: [],
    nodes: [],
    suppressedSinkTargetIds: [...new Set(suppressedSinkTargetIds)].sort(),
  });
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
function emptyProjection(): LogisticsResourceDemandProjection {
  return freeze({
    blockers: [],
    dispositions: [],
    edges: [],
    endpoints: [],
    nodes: [],
    suppressedSinkTargetIds: [],
  });
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
