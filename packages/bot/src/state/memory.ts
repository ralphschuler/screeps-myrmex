import { MemoryManager } from "./manager";
import {
  advanceMyrmexMigration,
  beginCurrentMyrmexMigration,
  beginMyrmexMigration,
  createCurrentMyrmexMemory,
} from "./migrations";
import {
  MEMORY_TARGET_SCHEMA_VERSION,
  PREVIOUS_MEMORY_SCHEMA_VERSION,
  type DeepReadonly,
  type MemoryMigrationCursor,
  type MemoryRecoveryMarker,
} from "./schema";
import {
  isCurrentMyrmexMemory,
  isMigratingMyrmexMemory,
  isPreviousMyrmexMemory,
} from "./validation";

export const DEFAULT_MIGRATION_STEP_BUDGET = 1 as const;
export const MAX_MIGRATION_STEP_BUDGET = 4 as const;

export interface OpenMemoryOptions {
  /** Constant-size migration operations permitted this tick. Clamped to the exported maximum. */
  readonly migrationStepBudget?: number;
}

export interface ReadyMemoryResult {
  readonly status: "ready";
  readonly manager: MemoryManager;
  readonly migrationStepsApplied: number;
}

export interface RecoveryMemoryResult {
  readonly status: "recovery";
  readonly cursor: DeepReadonly<MemoryMigrationCursor>;
  readonly marker: DeepReadonly<MemoryRecoveryMarker>;
  readonly migrationStepsApplied: number;
}

export interface UnsupportedMemoryResult {
  readonly status: "unsupported";
  readonly foundSchemaVersion: number;
  readonly targetSchemaVersion: typeof MEMORY_TARGET_SCHEMA_VERSION;
  readonly migrationStepsApplied: 0;
}

export type OpenMemoryResult = ReadyMemoryResult | RecoveryMemoryResult | UnsupportedMemoryResult;

/**
 * Opens the sole persistent-state authority. Callers must run recovery-safe systems only unless the
 * result is `ready`; a ready result exposes state solely through its MemoryManager.
 */
export function openMyrmexMemory(
  memory: Memory,
  gameTime: number,
  shard: string,
  options: OpenMemoryOptions = {},
): OpenMemoryResult {
  const budget = normalizeBudget(options.migrationStepBudget);
  const raw: unknown = memory.myrmex;

  if (raw === undefined) {
    const current = createCurrentMyrmexMemory(gameTime, shard);
    memory.myrmex = current;
    return {
      status: "ready",
      manager: new MemoryManager(memory, current, gameTime),
      migrationStepsApplied: 0,
    };
  }

  if (isCurrentMyrmexMemory(raw)) {
    return {
      status: "ready",
      manager: new MemoryManager(memory, raw, gameTime),
      migrationStepsApplied: 0,
    };
  }

  const declaredVersion = readDeclaredSchemaVersion(raw);
  const maximumDeclaredVersion = readMaximumDeclaredSchemaVersion(raw);
  if (maximumDeclaredVersion !== null && maximumDeclaredVersion > MEMORY_TARGET_SCHEMA_VERSION) {
    return {
      status: "unsupported",
      foundSchemaVersion: maximumDeclaredVersion,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      migrationStepsApplied: 0,
    };
  }

  let stepsApplied = 0;
  let migrating: ReturnType<typeof beginMyrmexMigration>;
  if (isMigratingMyrmexMemory(raw)) {
    migrating = raw;
  } else if (isPreviousMyrmexMemory(raw)) {
    migrating = beginCurrentMyrmexMigration(memory, raw, gameTime, shard, "schema-migration");
    stepsApplied += 1;
  } else if (
    declaredVersion === PREVIOUS_MEMORY_SCHEMA_VERSION ||
    declaredVersion === MEMORY_TARGET_SCHEMA_VERSION
  ) {
    migrating = beginCurrentMyrmexMigration(memory, raw, gameTime, shard, "corrupt-root");
    stepsApplied += 1;
  } else {
    migrating = beginMyrmexMigration(
      memory,
      raw,
      gameTime,
      shard,
      isLegacyV1(raw) ? "schema-migration" : "corrupt-root",
    );
    stepsApplied += 1;
  }

  while (stepsApplied < budget) {
    const progress = advanceMyrmexMigration(memory, migrating, gameTime);
    stepsApplied += 1;

    if (progress.completed) {
      if (!isCurrentMyrmexMemory(progress.root)) {
        throw new Error("Completed MYRMEX migration did not produce current memory");
      }

      return {
        status: "ready",
        manager: new MemoryManager(memory, progress.root, gameTime),
        migrationStepsApplied: stepsApplied,
      };
    }

    if (!isMigratingMyrmexMemory(progress.root)) {
      throw new Error("Incomplete MYRMEX migration lost its cursor");
    }
    migrating = progress.root;
  }

  return {
    status: "recovery",
    cursor: freezeCopy(migrating.meta.migration),
    marker: freezeCopy(migrating.meta.recovery),
    migrationStepsApplied: stepsApplied,
  };
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MIGRATION_STEP_BUDGET;
  }

  return Math.max(1, Math.min(MAX_MIGRATION_STEP_BUDGET, Math.floor(value)));
}

function isLegacyV1(value: unknown): boolean {
  return isRecord(value) && value.schema === 1 && !("meta" in value);
}

function readDeclaredSchemaVersion(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    isRecord(value.meta) &&
    typeof value.meta.schemaVersion === "number" &&
    Number.isSafeInteger(value.meta.schemaVersion)
  ) {
    return value.meta.schemaVersion;
  }

  if (typeof value.schema === "number" && Number.isSafeInteger(value.schema)) {
    return value.schema;
  }

  return null;
}

function readMaximumDeclaredSchemaVersion(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  const candidates: unknown[] = [value.schema];
  if (isRecord(value.meta)) {
    candidates.push(value.meta.schemaVersion, value.meta.targetSchemaVersion);
    if (isRecord(value.meta.migration)) {
      candidates.push(value.meta.migration.fromVersion, value.meta.migration.targetVersion);
    }
  }

  const versions = candidates.filter(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0,
  );
  return versions.length === 0 ? null : Math.max(...versions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeCopy<T extends object>(value: T): DeepReadonly<T> {
  return Object.freeze({ ...value }) as DeepReadonly<T>;
}

export { MemoryManager, OwnerMemoryTransaction } from "./manager";
export type {
  MemoryCommitFault,
  MemoryCommitFaultCode,
  MemoryCommitResult,
  MemoryStageResult,
} from "./manager";
