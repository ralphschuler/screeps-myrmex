import {
  LEGACY_MEMORY_SCHEMA_VERSION,
  MEMORY_CURRENT_SCHEMA_VERSION,
  MEMORY_MIGRATION_ID,
  MEMORY_MIGRATION_STEP_COUNT,
  MEMORY_TARGET_SCHEMA_VERSION,
  MAX_MEMORY_DIAGNOSTICS,
  PERSISTENT_STATE_OWNERS,
  type JsonObject,
  type MemoryRecoveryReason,
  type MemoryDiagnostic,
  type MigratingMyrmexMemory,
  type MyrmexMemory,
  type MyrmexMemoryRoot,
  type PersistentStateOwner,
} from "./schema";
import {
  cloneJsonObject,
  isCurrentMyrmexMemory,
  isJsonObject,
  isMigratingMyrmexMemory,
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
  const state = emptyOwnerState();

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
    ...state,
  };
}

/**
 * Replaces a legacy or invalid root with a minimal recovery envelope. Copying only validated boot
 * metadata makes this operation restartable and prevents legacy tick snapshots from surviving.
 */
export function beginMyrmexMigration(
  memory: Memory,
  source: unknown,
  gameTime: number,
  shard: string,
  reason: MemoryRecoveryReason,
): MigratingMyrmexMemory {
  const tick = normalizeTick(gameTime);
  const boot = extractBootMetadata(source, tick, shard);
  const salvagedOwners = salvageAuthorityState(source);
  const migration: MigratingMyrmexMemory = {
    meta: {
      schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: 0,
      firstTick: boot.firstTick,
      lastTick: Math.max(boot.lastTick, tick),
      shard: boot.shard,
      diagnostics: [diagnostic("recovery-start", tick, reason)],
      migration: {
        id: MEMORY_MIGRATION_ID,
        fromVersion: LEGACY_MEMORY_SCHEMA_VERSION,
        targetVersion: MEMORY_TARGET_SCHEMA_VERSION,
        nextStep: 0,
        stepCount: MEMORY_MIGRATION_STEP_COUNT,
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
    ...salvagedOwners,
  };

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
  const step = root.meta.migration.nextStep;

  switch (step) {
    case 0:
      return persistStep(memory, root, tick, CORE_OWNERS);
    case 1:
      return persistStep(memory, root, tick, STRATEGY_OWNERS);
    case 2:
      return persistStep(memory, root, tick, SERVICE_OWNERS);
    case 3:
      return finalizeMigration(memory, root, tick);
    default:
      throw new Error(`Unsupported MYRMEX migration step: ${String(step)}`);
  }
}

function persistStep(
  memory: Memory,
  root: MigratingMyrmexMemory,
  tick: number,
  owners: readonly PersistentStateOwner[],
): MigrationAdvanceResult {
  const nextStep = root.meta.migration.nextStep + 1;
  const additions = Object.fromEntries(
    owners.map((owner) => [owner, root[owner] ?? {}]),
  ) as Partial<Record<PersistentStateOwner, Record<string, never>>>;
  const next: MigratingMyrmexMemory = {
    ...root,
    ...additions,
    meta: {
      ...root.meta,
      lastTick: Math.max(root.meta.lastTick, tick),
      migration: {
        ...root.meta.migration,
        nextStep,
        updatedAt: tick,
      },
      recovery: {
        ...root.meta.recovery,
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

function finalizeMigration(
  memory: Memory,
  root: MigratingMyrmexMemory,
  tick: number,
): MigrationAdvanceResult {
  const ownerState = Object.fromEntries(
    PERSISTENT_STATE_OWNERS.map((owner) => [owner, root[owner]]),
  ) as Record<PersistentStateOwner, Record<string, never>>;
  const current: MyrmexMemory = {
    meta: {
      schemaVersion: MEMORY_CURRENT_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: root.meta.revision,
      firstTick: root.meta.firstTick,
      lastTick: Math.max(root.meta.lastTick, tick),
      diagnostics: appendDiagnostic(
        root.meta.diagnostics,
        diagnostic("migration-complete", tick, root.meta.recovery.reason),
      ),
      shard: root.meta.shard,
      migration: null,
      recovery: null,
    },
    ...ownerState,
  };

  if (!isCurrentMyrmexMemory(current)) {
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

function salvageAuthorityState(source: unknown): Partial<Record<PersistentStateOwner, JsonObject>> {
  if (!isRecord(source) || !isRecord(source.meta) || source.meta.schemaVersion !== 2) {
    return {};
  }

  return Object.fromEntries(
    PERSISTENT_STATE_OWNERS.flatMap((owner) => {
      const candidate = source[owner];
      return isJsonObject(candidate) ? [[owner, cloneJsonObject(candidate)] as const] : [];
    }),
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
