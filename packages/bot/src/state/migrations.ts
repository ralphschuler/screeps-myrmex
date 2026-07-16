import {
  LEGACY_MEMORY_MIGRATION_ID,
  LEGACY_MEMORY_MIGRATION_STEP_COUNT,
  LEGACY_MEMORY_SCHEMA_VERSION,
  INTERMEDIATE_MEMORY_SCHEMA_VERSION,
  INTERMEDIATE_PERSISTENT_STATE_OWNERS,
  MEMORY_CURRENT_SCHEMA_VERSION,
  MEMORY_MIGRATION_ID,
  MEMORY_MIGRATION_STEP_COUNT,
  MEMORY_TARGET_SCHEMA_VERSION,
  MAX_MEMORY_DIAGNOSTICS,
  PERSISTENT_STATE_OWNERS,
  PREVIOUS_MEMORY_SCHEMA_VERSION,
  PREVIOUS_PERSISTENT_STATE_OWNERS,
  LAYOUT_MEMORY_MIGRATION_ID,
  LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION,
  LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS,
  type JsonObject,
  type LegacyMigratingMyrmexMemoryMeta,
  type IntermediateMyrmexMemory,
  type MemoryDiagnostic,
  type MemoryRecoveryReason,
  type MigratingMyrmexMemory,
  type MyrmexMemory,
  type MyrmexMemoryRoot,
  type PersistentStateOwner,
  type PreviousPersistentStateOwner,
  type IntermediatePersistentStateOwner,
  type LayoutPreviousPersistentStateOwner,
} from "./schema";
import {
  cloneJsonObject,
  isCurrentMyrmexMemory,
  isJsonObject,
  isMigratingMyrmexMemory,
  isPreviousMyrmexMemory,
  selectMigrationFinalState,
} from "./validation";

const CORE_OWNERS = ["kernel", "empire", "colonies", "contracts"] as const;
const STRATEGY_OWNERS = ["diplomacy", "remotes", "expansion", "operations", "industry"] as const;
const SERVICE_OWNERS = ["segments", "telemetry"] as const;

export interface MigrationAdvanceResult {
  readonly completed: boolean;
  readonly root: MyrmexMemoryRoot;
}

export function createCurrentMyrmexMemory(gameTime: number, shard: string): MyrmexMemory {
  const tick = normalizeTick(gameTime);

  return {
    meta: {
      schemaVersion: MEMORY_CURRENT_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: 0,
      firstTick: tick,
      lastTick: tick,
      shard: normalizeShard(shard),
      diagnostics: [],
      migration: null,
      recovery: null,
    },
    ...emptyOwnerState(),
  };
}

/**
 * Starts the historical v1-to-v2 recovery protocol. Its persisted literals intentionally remain
 * unchanged so a cursor written by the deployed schema-2 bot can be resumed by schema 3.
 */
export function beginMyrmexMigration(
  memory: Memory,
  source: unknown,
  gameTime: number,
  shard: string,
  reason: MemoryRecoveryReason,
): MigratingMyrmexMemory {
  if (
    isRecord(source) &&
    isRecord(source.meta) &&
    (source.meta.schemaVersion === INTERMEDIATE_MEMORY_SCHEMA_VERSION ||
      source.meta.schemaVersion === LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION)
  ) {
    return beginCurrentMyrmexMigration(memory, source, gameTime, shard, "schema-migration");
  }
  const tick = normalizeTick(gameTime);
  const boot = extractBootMetadata(source, tick, shard);
  const minimal: MigratingMyrmexMemory = {
    meta: {
      schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
      targetSchemaVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
      revision: 0,
      firstTick: boot.firstTick,
      lastTick: Math.max(boot.lastTick, tick),
      shard: boot.shard,
      diagnostics: [diagnostic("recovery-start", tick, reason)],
      migration: {
        id: LEGACY_MEMORY_MIGRATION_ID,
        fromVersion: LEGACY_MEMORY_SCHEMA_VERSION,
        targetVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
        nextStep: 0,
        stepCount: LEGACY_MEMORY_MIGRATION_STEP_COUNT,
        startedAt: tick,
        updatedAt: tick,
      },
      recovery: {
        active: true,
        lastProgressTick: tick,
        reason,
        sinceTick: tick,
      },
    },
  };
  const base: MigratingMyrmexMemory = carriesMigrationId(source, LEGACY_MEMORY_MIGRATION_ID)
    ? { ...minimal, ...emptyPreviousOwnerState() }
    : minimal;
  const migration = fitRecognizedAuthorityState(source, base);

  memory.myrmex = migration;
  return migration;
}

/** Starts the bounded v2-to-v3 config-owner migration or repairs a malformed known root. */
export function beginCurrentMyrmexMigration(
  memory: Memory,
  source: unknown,
  gameTime: number,
  shard: string,
  reason: MemoryRecoveryReason,
): MigratingMyrmexMemory {
  const tick = normalizeTick(gameTime);
  const boot = extractBootMetadata(source, tick, shard);
  const previous = isPreviousMyrmexMemory(source) ? source : undefined;
  const intermediate = isIntermediateMemory(source) ? source : undefined;
  const fromLayoutPrevious =
    intermediate !== undefined ||
    (isRecord(source) &&
      isRecord(source.meta) &&
      source.meta.schemaVersion === LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION);
  const start = diagnostic("recovery-start", tick, reason);
  const migrationCursor = fromLayoutPrevious
    ? ({
        id: LAYOUT_MEMORY_MIGRATION_ID,
        fromVersion: LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION,
        targetVersion: MEMORY_TARGET_SCHEMA_VERSION,
        nextStep: 0,
        stepCount: MEMORY_MIGRATION_STEP_COUNT,
        startedAt: tick,
        updatedAt: tick,
      } as const)
    : ({
        id: MEMORY_MIGRATION_ID,
        fromVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
        targetVersion: MEMORY_TARGET_SCHEMA_VERSION,
        nextStep: 0,
        stepCount: MEMORY_MIGRATION_STEP_COUNT,
        startedAt: tick,
        updatedAt: tick,
      } as const);
  const base: MigratingMyrmexMemory = {
    meta: {
      schemaVersion: fromLayoutPrevious
        ? LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION
        : PREVIOUS_MEMORY_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: previous?.meta.revision ?? intermediate?.meta.revision ?? 0,
      firstTick: boot.firstTick,
      lastTick: Math.max(boot.lastTick, tick),
      shard: boot.shard,
      diagnostics:
        previous === undefined ? [start] : appendDiagnostic(previous.meta.diagnostics, start),
      migration: migrationCursor,
      recovery: {
        active: true,
        lastProgressTick: tick,
        reason,
        sinceTick: tick,
      },
    } as MigratingMyrmexMemory["meta"],
    ...(fromLayoutPrevious ? emptyLayoutPreviousOwnerState() : emptyPreviousOwnerState()),
  };
  const migration = fitRecognizedAuthorityState(source, base);

  memory.myrmex = migration;
  return migration;
}

/** Advances exactly one constant-size migration step and persists that cursor atomically. */
export function advanceMyrmexMigration(
  memory: Memory,
  root: MigratingMyrmexMemory,
  gameTime: number,
): MigrationAdvanceResult {
  if (!isMigratingMyrmexMemory(root)) {
    throw new Error("Cannot advance an invalid MYRMEX migration root");
  }

  const tick = normalizeTick(gameTime);
  const migration = root.meta.migration;

  if (migration.id === MEMORY_MIGRATION_ID || migration.id === LAYOUT_MEMORY_MIGRATION_ID) {
    if (migration.nextStep !== 0) {
      throw new Error(`Unsupported MYRMEX v2-to-v3 migration step: ${String(migration.nextStep)}`);
    }
    return finalizeCurrentMigration(memory, root, tick);
  }

  switch (migration.nextStep) {
    case 0:
      return persistLegacyStep(memory, root, tick, CORE_OWNERS);
    case 1:
      return persistLegacyStep(memory, root, tick, STRATEGY_OWNERS);
    case 2:
      return persistLegacyStep(memory, root, tick, SERVICE_OWNERS);
    case 3:
      return transitionLegacyMigration(memory, root, tick);
    default:
      throw new Error(`Unsupported MYRMEX v1-to-v2 migration step: ${String(migration.nextStep)}`);
  }
}

function persistLegacyStep(
  memory: Memory,
  root: MigratingMyrmexMemory,
  tick: number,
  owners: readonly PreviousPersistentStateOwner[],
): MigrationAdvanceResult {
  if (root.meta.migration.id !== LEGACY_MEMORY_MIGRATION_ID) {
    throw new Error("Cannot apply a legacy step to the current migration cursor");
  }

  const meta = root.meta as LegacyMigratingMyrmexMemoryMeta;
  const nextStep = meta.migration.nextStep + 1;
  const additions = Object.fromEntries(
    owners.map((owner) => [owner, root[owner] ?? {}]),
  ) as Partial<Record<PreviousPersistentStateOwner, JsonObject>>;
  const next: MigratingMyrmexMemory = {
    ...root,
    ...additions,
    meta: {
      ...meta,
      lastTick: Math.max(meta.lastTick, tick),
      migration: {
        ...meta.migration,
        nextStep,
        updatedAt: tick,
      },
      recovery: {
        ...meta.recovery,
        lastProgressTick: tick,
      },
    },
  };

  if (!isMigratingMyrmexMemory(next)) {
    throw new Error(
      `MYRMEX migration step ${String(root.meta.migration.nextStep)} produced invalid state`,
    );
  }

  memory.myrmex = next;
  return { completed: false, root: next };
}

/** Atomically leaves the historical cursor and persists the next supported migration cursor. */
function transitionLegacyMigration(
  memory: Memory,
  root: MigratingMyrmexMemory,
  tick: number,
): MigrationAdvanceResult {
  if (root.meta.migration.id !== LEGACY_MEMORY_MIGRATION_ID) {
    throw new Error("Cannot transition a non-legacy migration cursor");
  }

  const base: MigratingMyrmexMemory = {
    meta: {
      schemaVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: root.meta.revision,
      firstTick: root.meta.firstTick,
      lastTick: Math.max(root.meta.lastTick, tick),
      shard: root.meta.shard,
      diagnostics: root.meta.diagnostics,
      migration: {
        id: MEMORY_MIGRATION_ID,
        fromVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
        targetVersion: MEMORY_TARGET_SCHEMA_VERSION,
        nextStep: 0,
        stepCount: MEMORY_MIGRATION_STEP_COUNT,
        startedAt: tick,
        updatedAt: tick,
      },
      recovery: {
        ...root.meta.recovery,
        lastProgressTick: tick,
      },
    },
    ...emptyIntermediateOwnerState(),
  };
  const next = fitRecognizedAuthorityState(root, base);

  memory.myrmex = next;
  return { completed: false, root: next };
}

function finalizeCurrentMigration(
  memory: Memory,
  root: MigratingMyrmexMemory,
  tick: number,
): MigrationAdvanceResult {
  if (
    root.meta.migration.id !== MEMORY_MIGRATION_ID &&
    root.meta.migration.id !== LAYOUT_MEMORY_MIGRATION_ID
  ) {
    throw new Error("Cannot finalize current memory from a legacy migration cursor");
  }

  const current = selectMigrationFinalState(root, tick);

  if (current === null || !isCurrentMyrmexMemory(current)) {
    throw new Error("MYRMEX migration finalization produced invalid current state");
  }

  memory.myrmex = current;
  return { completed: true, root: current };
}

function emptyOwnerState(): Record<PersistentStateOwner, Record<string, never>> {
  return Object.fromEntries(PERSISTENT_STATE_OWNERS.map((owner) => [owner, {}])) as Record<
    PersistentStateOwner,
    Record<string, never>
  >;
}

function emptyPreviousOwnerState(): Record<PreviousPersistentStateOwner, Record<string, never>> {
  return Object.fromEntries(PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [owner, {}])) as Record<
    PreviousPersistentStateOwner,
    Record<string, never>
  >;
}

function emptyIntermediateOwnerState(): Record<
  IntermediatePersistentStateOwner,
  Record<string, never>
> {
  return Object.fromEntries(
    INTERMEDIATE_PERSISTENT_STATE_OWNERS.map((owner) => [owner, {}]),
  ) as Record<IntermediatePersistentStateOwner, Record<string, never>>;
}

function emptyLayoutPreviousOwnerState(): Record<
  LayoutPreviousPersistentStateOwner,
  Record<string, never>
> {
  return Object.fromEntries(
    LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [owner, {}]),
  ) as Record<LayoutPreviousPersistentStateOwner, Record<string, never>>;
}

/**
 * Greedily preserves recognized owner payloads in canonical priority order. Every choice validates
 * the complete persisted envelope, so individually valid subtrees cannot overflow aggregate limits.
 */
function fitRecognizedAuthorityState(
  source: unknown,
  base: MigratingMyrmexMemory,
): MigratingMyrmexMemory {
  if (!isRecord(source)) {
    return base;
  }

  const recognized = recognizedAuthorityOwners(source);
  let fitted = base;
  for (const owner of PERSISTENT_STATE_OWNERS) {
    if (!recognized.includes(owner)) {
      continue;
    }

    const candidate = source[owner];
    if (!isJsonObject(candidate)) {
      continue;
    }

    const next: MigratingMyrmexMemory = {
      ...fitted,
      [owner]: cloneJsonObject(candidate),
    };
    if (isMigratingMyrmexMemory(next)) {
      fitted = next;
    }
  }

  return fitted;
}

function recognizedAuthorityOwners(
  source: Record<string, unknown>,
): readonly PersistentStateOwner[] {
  if (!isRecord(source.meta)) {
    return [];
  }

  const meta = source.meta;
  const migrationId = isRecord(meta.migration) ? meta.migration.id : null;
  if (
    meta.schemaVersion === MEMORY_CURRENT_SCHEMA_VERSION ||
    meta.targetSchemaVersion === MEMORY_CURRENT_SCHEMA_VERSION ||
    migrationId === LAYOUT_MEMORY_MIGRATION_ID
  ) {
    return PERSISTENT_STATE_OWNERS;
  }

  if (
    meta.schemaVersion === PREVIOUS_MEMORY_SCHEMA_VERSION ||
    migrationId === LEGACY_MEMORY_MIGRATION_ID
  ) {
    return PREVIOUS_PERSISTENT_STATE_OWNERS;
  }

  if (meta.schemaVersion === LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION) {
    return LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS;
  }

  if (
    meta.schemaVersion === INTERMEDIATE_MEMORY_SCHEMA_VERSION ||
    migrationId === MEMORY_MIGRATION_ID
  ) {
    return PREVIOUS_PERSISTENT_STATE_OWNERS;
  }

  return [];
}

function isIntermediateMemory(value: unknown): value is IntermediateMyrmexMemory {
  if (
    !isRecord(value) ||
    !isRecord(value.meta) ||
    value.meta.schemaVersion !== LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION
  )
    return false;
  return LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS.every((owner) => isJsonObject(value[owner]));
}

function carriesMigrationId(source: unknown, id: string): boolean {
  return (
    isRecord(source) &&
    isRecord(source.meta) &&
    isRecord(source.meta.migration) &&
    source.meta.migration.id === id
  );
}

function diagnostic(
  code: MemoryDiagnostic["code"],
  tick: number,
  detail: string,
): MemoryDiagnostic {
  return { code, tick, detail: detail.slice(0, 128) };
}

function appendDiagnostic(
  diagnostics: readonly MemoryDiagnostic[],
  next: MemoryDiagnostic,
): readonly MemoryDiagnostic[] {
  return [...diagnostics, next].slice(-MAX_MEMORY_DIAGNOSTICS);
}

function extractBootMetadata(
  source: unknown,
  fallbackTick: number,
  fallbackShard: string,
): { readonly firstTick: number; readonly lastTick: number; readonly shard: string } {
  if (!isRecord(source)) {
    return {
      firstTick: fallbackTick,
      lastTick: fallbackTick,
      shard: normalizeShard(fallbackShard),
    };
  }

  const metadata = isRecord(source.meta)
    ? source.meta
    : isRecord(source.boot)
      ? source.boot
      : undefined;

  if (metadata === undefined) {
    return {
      firstTick: fallbackTick,
      lastTick: fallbackTick,
      shard: normalizeShard(fallbackShard),
    };
  }

  const firstTick = isTick(metadata.firstTick) ? metadata.firstTick : fallbackTick;
  const lastTick = isTick(metadata.lastTick) ? Math.max(metadata.lastTick, firstTick) : firstTick;
  const sourceShard = typeof metadata.shard === "string" ? metadata.shard : fallbackShard;

  return { firstTick, lastTick, shard: normalizeShard(sourceShard) };
}

function normalizeTick(value: number): number {
  return isTick(value) ? value : 0;
}

function isTick(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeShard(value: string): string {
  return value.length > 0 ? value : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
