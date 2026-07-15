import { MemoryManager } from "./manager";
import {
  advanceMyrmexMigration,
  beginMyrmexMigration,
  createCurrentMyrmexMemory,
} from "./migrations";
import {
  MEMORY_TARGET_SCHEMA_VERSION,
  type DeepReadonly,
  type MemoryMigrationCursor,
  type MemoryRecoveryMarker,
} from "./schema";
import { isCurrentMyrmexMemory, isMigratingMyrmexMemory } from "./validation";

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
  if (declaredVersion !== null && declaredVersion > MEMORY_TARGET_SCHEMA_VERSION) {
    return {
      status: "unsupported",
      foundSchemaVersion: declaredVersion,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      migrationStepsApplied: 0,
    };
  }

  let stepsApplied = 0;
  let migrating = isMigratingMyrmexMemory(raw)
    ? raw
    : beginMyrmexMigration(
        memory,
        raw,
        gameTime,
        shard,
        isLegacyV1(raw) ? "schema-migration" : "corrupt-root",
      );

  if (!isMigratingMyrmexMemory(raw)) {
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

  if (typeof value.schema === "number" && Number.isSafeInteger(value.schema)) {
    return value.schema;
  }

  if (
    isRecord(value.meta) &&
    typeof value.meta.schemaVersion === "number" &&
    Number.isSafeInteger(value.meta.schemaVersion)
  ) {
    return value.meta.schemaVersion;
  }

  return null;
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
