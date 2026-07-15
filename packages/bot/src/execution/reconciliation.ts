import type { CommandExecutionResult } from "./command-executor";

export interface CacheInvalidationRequest {
  readonly namespace: string;
  readonly key: string;
  readonly sourceIntentId: string;
  readonly reason: string;
}

/**
 * Pure output for the owning reconciler. It deliberately has no commit or
 * persistence capability; the runtime's transaction owner applies it later.
 */
export interface ReconciliationProjection<Delta> {
  readonly intentId: string;
  readonly delta: Delta | null;
  readonly cacheInvalidations: readonly CacheInvalidationRequest[];
}

export interface ResultReconciler<Command, Delta> {
  fromResult(result: CommandExecutionResult<Command>): ReconciliationProjection<Delta>;
}

export function projectReconciliation<Command, Delta>(
  results: readonly CommandExecutionResult<Command>[],
  reconciler: ResultReconciler<Command, Delta>,
): readonly ReconciliationProjection<Delta>[] {
  return Object.freeze(
    results.map((result) => {
      const projection = reconciler.fromResult(result);
      if (projection.intentId !== result.intentId) {
        throw new Error(
          `reconciliation projection ${projection.intentId} does not match result ${result.intentId}`,
        );
      }
      const cacheInvalidations = projection.cacheInvalidations.map((invalidation) => {
        if (invalidation.sourceIntentId !== result.intentId) {
          throw new Error(
            `cache invalidation ${invalidation.sourceIntentId} does not match result ${result.intentId}`,
          );
        }
        const fields = [
          ["namespace", invalidation.namespace],
          ["key", invalidation.key],
          ["sourceIntentId", invalidation.sourceIntentId],
          ["reason", invalidation.reason],
        ] as const;
        for (const [field, value] of fields) {
          if (value.trim().length === 0 || value !== value.trim()) {
            throw new Error(`cache invalidation ${field} must be non-empty and trimmed`);
          }
        }
        return Object.freeze({ ...invalidation });
      });
      return Object.freeze({
        intentId: projection.intentId,
        delta: projection.delta,
        cacheInvalidations: Object.freeze(cacheInvalidations),
      });
    }),
  );
}
