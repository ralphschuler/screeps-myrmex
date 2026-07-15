import {
  MEMORY_CURRENT_SCHEMA_VERSION,
  MEMORY_TARGET_SCHEMA_VERSION,
  MAX_MEMORY_DIAGNOSTICS,
  PERSISTENT_STATE_OWNERS,
  type JsonObject,
  type MemoryDiagnostic,
  type MigratingMyrmexMemory,
  type MyrmexMemory,
  type PersistentStateOwner,
} from "./schema";

/**
 * Builds one schema-3 finalization candidate. Validation chooses deterministically between the
 * preferred completion-diagnostic candidate and the otherwise-identical owner-preserving fallback.
 */
export function projectMigrationFinalState(
  root: MigratingMyrmexMemory,
  tick: number,
  includeCompletionDiagnostic: boolean,
): MyrmexMemory {
  const ownerState = Object.fromEntries(
    PERSISTENT_STATE_OWNERS.map((owner) => [owner, root[owner] ?? {}]),
  ) as Record<PersistentStateOwner, JsonObject>;
  const diagnostics = includeCompletionDiagnostic
    ? [
        ...root.meta.diagnostics,
        {
          code: "migration-complete",
          tick,
          detail: root.meta.recovery.reason,
        } satisfies MemoryDiagnostic,
      ].slice(-MAX_MEMORY_DIAGNOSTICS)
    : [...root.meta.diagnostics];

  return {
    meta: {
      schemaVersion: MEMORY_CURRENT_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: root.meta.revision,
      firstTick: root.meta.firstTick,
      lastTick: Math.max(root.meta.lastTick, tick),
      diagnostics,
      shard: root.meta.shard,
      migration: null,
      recovery: null,
    },
    ...ownerState,
  };
}
