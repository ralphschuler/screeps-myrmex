/**
 * Durable MYRMEX state is ordinary JSON because Screeps serializes `Memory` with JSON.stringify.
 * Runtime snapshots, game objects, functions, and heap caches do not belong in these types.
 */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type DeepReadonly<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : never;

export const LEGACY_MEMORY_SCHEMA_VERSION = 1 as const;
export const MEMORY_CURRENT_SCHEMA_VERSION = 2 as const;
export const MEMORY_TARGET_SCHEMA_VERSION = MEMORY_CURRENT_SCHEMA_VERSION;

/** Compatibility name for callers that only need the active durable schema number. */
export const MEMORY_SCHEMA_VERSION = MEMORY_CURRENT_SCHEMA_VERSION;

export const PERSISTENT_STATE_OWNERS = [
  "kernel",
  "empire",
  "colonies",
  "contracts",
  "diplomacy",
  "remotes",
  "expansion",
  "operations",
  "industry",
  "segments",
  "telemetry",
] as const;

export type PersistentStateOwner = (typeof PERSISTENT_STATE_OWNERS)[number];

export const MEMORY_MIGRATION_ID = "myrmex-memory-v1-to-v2" as const;
export const MEMORY_MIGRATION_STEP_COUNT = 4 as const;
export const MAX_MEMORY_DIAGNOSTICS = 16 as const;

export type MemoryRecoveryReason = "corrupt-root" | "schema-migration";

export interface MemoryMigrationCursor {
  readonly id: typeof MEMORY_MIGRATION_ID;
  readonly fromVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
  readonly targetVersion: typeof MEMORY_TARGET_SCHEMA_VERSION;
  /** Zero-based index of the next migration step to execute. */
  readonly nextStep: number;
  readonly stepCount: typeof MEMORY_MIGRATION_STEP_COUNT;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface MemoryRecoveryMarker {
  readonly active: true;
  readonly lastProgressTick: number;
  readonly reason: MemoryRecoveryReason;
  readonly sinceTick: number;
}

export interface MemoryDiagnostic {
  readonly code: "migration-complete" | "recovery-start";
  readonly tick: number;
  readonly detail: string;
}

export interface MyrmexMemoryMeta {
  readonly schemaVersion: typeof MEMORY_CURRENT_SCHEMA_VERSION;
  readonly targetSchemaVersion: typeof MEMORY_TARGET_SCHEMA_VERSION;
  readonly revision: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly shard: string;
  readonly diagnostics: readonly MemoryDiagnostic[];
  readonly migration: null;
  readonly recovery: null;
}

export interface MigratingMyrmexMemoryMeta {
  readonly schemaVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
  readonly targetSchemaVersion: typeof MEMORY_TARGET_SCHEMA_VERSION;
  readonly revision: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly shard: string;
  readonly diagnostics: readonly MemoryDiagnostic[];
  readonly migration: MemoryMigrationCursor;
  readonly recovery: MemoryRecoveryMarker;
}

export type PersistentOwnerState = Readonly<Record<PersistentStateOwner, JsonObject>>;

export interface MyrmexMemory extends PersistentOwnerState {
  readonly meta: MyrmexMemoryMeta;
}

/**
 * An intentionally small recovery root. Owner subtrees are added in bounded migration steps. The
 * legacy `world` and tick telemetry values are never copied into it.
 */
export type MigratingMyrmexMemory = {
  readonly meta: MigratingMyrmexMemoryMeta;
} & Partial<PersistentOwnerState>;

export type MyrmexMemoryRoot = MyrmexMemory | MigratingMyrmexMemory;
export type StateView = DeepReadonly<MyrmexMemory>;
export type OwnerStateView = DeepReadonly<JsonObject>;

declare global {
  interface Memory {
    myrmex?: MyrmexMemoryRoot;
  }
}
