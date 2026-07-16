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
export const INTERMEDIATE_MEMORY_SCHEMA_VERSION = 2 as const;
/** Stable compatibility name for the deployed schema-2 root. */
export const PREVIOUS_MEMORY_SCHEMA_VERSION = INTERMEDIATE_MEMORY_SCHEMA_VERSION;
export const LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION = 3 as const;
export const MEMORY_CURRENT_SCHEMA_VERSION = 4 as const;
export const MEMORY_TARGET_SCHEMA_VERSION = MEMORY_CURRENT_SCHEMA_VERSION;

/** Compatibility name for callers that only need the active durable schema number. */
export const MEMORY_SCHEMA_VERSION = MEMORY_CURRENT_SCHEMA_VERSION;

/** Owners present in the deployed schema-2 root and historical v1-to-v2 migration. */
export const INTERMEDIATE_PERSISTENT_STATE_OWNERS = [
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

export const PREVIOUS_PERSISTENT_STATE_OWNERS = INTERMEDIATE_PERSISTENT_STATE_OWNERS;
export const LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS = [
  "config",
  ...PREVIOUS_PERSISTENT_STATE_OWNERS,
] as const;
export const PERSISTENT_STATE_OWNERS = [
  ...LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS,
  "layouts",
] as const;

export type PreviousPersistentStateOwner = (typeof PREVIOUS_PERSISTENT_STATE_OWNERS)[number];
export type IntermediatePersistentStateOwner =
  (typeof INTERMEDIATE_PERSISTENT_STATE_OWNERS)[number];
export type LayoutPreviousPersistentStateOwner =
  (typeof LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS)[number];
export type PersistentStateOwner = (typeof PERSISTENT_STATE_OWNERS)[number];

/** These literals are persisted by deployed code and must remain stable. */
export const LEGACY_MEMORY_MIGRATION_ID = "myrmex-memory-v1-to-v2" as const;
export const LEGACY_MEMORY_MIGRATION_STEP_COUNT = 4 as const;
export const MEMORY_MIGRATION_ID = "myrmex-memory-v2-to-v3" as const;
/** Compatibility name introduced while schema 4 was being added. */
export const INTERMEDIATE_MEMORY_MIGRATION_ID = MEMORY_MIGRATION_ID;
export const LAYOUT_MEMORY_MIGRATION_ID = "myrmex-memory-v3-to-v4" as const;
export const MEMORY_MIGRATION_STEP_COUNT = 1 as const;
export const MAX_MEMORY_DIAGNOSTICS = 16 as const;

export type MemoryRecoveryReason = "corrupt-root" | "schema-migration";

export interface LegacyMemoryMigrationCursor {
  readonly id: typeof LEGACY_MEMORY_MIGRATION_ID;
  readonly fromVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
  readonly targetVersion: typeof INTERMEDIATE_MEMORY_SCHEMA_VERSION;
  /** Zero-based index of the next migration step to execute. */
  readonly nextStep: number;
  readonly stepCount: typeof LEGACY_MEMORY_MIGRATION_STEP_COUNT;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface IntermediateMemoryMigrationCursor {
  readonly id: typeof MEMORY_MIGRATION_ID;
  readonly fromVersion: typeof INTERMEDIATE_MEMORY_SCHEMA_VERSION;
  readonly targetVersion:
    typeof LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION | typeof MEMORY_TARGET_SCHEMA_VERSION;
  readonly nextStep: number;
  readonly stepCount: typeof MEMORY_MIGRATION_STEP_COUNT;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface CurrentMemoryMigrationCursor {
  readonly id: typeof LAYOUT_MEMORY_MIGRATION_ID;
  readonly fromVersion: typeof LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION;
  readonly targetVersion: typeof MEMORY_TARGET_SCHEMA_VERSION;
  /** Zero-based index of the next migration step to execute. */
  readonly nextStep: number;
  readonly stepCount: typeof MEMORY_MIGRATION_STEP_COUNT;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export type MemoryMigrationCursor =
  LegacyMemoryMigrationCursor | IntermediateMemoryMigrationCursor | CurrentMemoryMigrationCursor;

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

export interface PreviousMyrmexMemoryMeta {
  readonly schemaVersion: typeof PREVIOUS_MEMORY_SCHEMA_VERSION;
  readonly targetSchemaVersion: typeof PREVIOUS_MEMORY_SCHEMA_VERSION;
  readonly revision: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly shard: string;
  readonly diagnostics: readonly MemoryDiagnostic[];
  readonly migration: null;
  readonly recovery: null;
}

interface MigratingMyrmexMemoryMetaBase {
  readonly revision: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly shard: string;
  readonly diagnostics: readonly MemoryDiagnostic[];
  readonly recovery: MemoryRecoveryMarker;
}

export interface LegacyMigratingMyrmexMemoryMeta extends MigratingMyrmexMemoryMetaBase {
  readonly schemaVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
  readonly targetSchemaVersion: typeof INTERMEDIATE_MEMORY_SCHEMA_VERSION;
  readonly migration: LegacyMemoryMigrationCursor;
}

export interface IntermediateMigratingMyrmexMemoryMeta extends MigratingMyrmexMemoryMetaBase {
  readonly schemaVersion: typeof INTERMEDIATE_MEMORY_SCHEMA_VERSION;
  readonly targetSchemaVersion: typeof MEMORY_TARGET_SCHEMA_VERSION;
  readonly migration: IntermediateMemoryMigrationCursor;
}

export interface CurrentMigratingMyrmexMemoryMeta extends MigratingMyrmexMemoryMetaBase {
  readonly schemaVersion: typeof LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION;
  readonly targetSchemaVersion: typeof MEMORY_TARGET_SCHEMA_VERSION;
  readonly migration: CurrentMemoryMigrationCursor;
}

export type MigratingMyrmexMemoryMeta =
  | LegacyMigratingMyrmexMemoryMeta
  | IntermediateMigratingMyrmexMemoryMeta
  | CurrentMigratingMyrmexMemoryMeta;

export type PersistentOwnerState = Readonly<Record<PersistentStateOwner, JsonObject>>;
export type PreviousPersistentOwnerState = Readonly<
  Record<PreviousPersistentStateOwner, JsonObject>
>;
export type LayoutPreviousPersistentOwnerState = Readonly<
  Record<LayoutPreviousPersistentStateOwner, JsonObject>
>;

export interface MyrmexMemory extends PersistentOwnerState {
  readonly meta: MyrmexMemoryMeta;
}

export interface PreviousMyrmexMemory extends PreviousPersistentOwnerState {
  readonly meta: PreviousMyrmexMemoryMeta;
}

export type IntermediatePersistentOwnerState = Readonly<
  Record<IntermediatePersistentStateOwner, JsonObject>
>;
export interface IntermediateMyrmexMemory extends LayoutPreviousPersistentOwnerState {
  readonly meta: Omit<PreviousMyrmexMemoryMeta, "schemaVersion" | "targetSchemaVersion"> & {
    readonly schemaVersion: typeof LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION;
    readonly targetSchemaVersion: typeof LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION;
  };
}

/**
 * An intentionally small recovery root. Owner subtrees are added in bounded migration steps. The
 * legacy `world` and tick telemetry values are never copied into it.
 */
export type MigratingMyrmexMemory = {
  readonly meta: MigratingMyrmexMemoryMeta;
} & Partial<PersistentOwnerState>;

export type MyrmexMemoryRoot = MyrmexMemory | MigratingMyrmexMemory;
/** General consumers cannot inspect raw persistence owned by dedicated runtime authorities. */
export type StateView = DeepReadonly<
  Omit<MyrmexMemory, "config" | "colonies" | "contracts" | "layouts">
>;
export type OwnerStateView = DeepReadonly<JsonObject>;

declare global {
  interface Memory {
    myrmex?: MyrmexMemoryRoot;
  }
}
