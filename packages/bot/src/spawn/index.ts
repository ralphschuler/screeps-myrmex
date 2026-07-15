import type { SpawnBrokerResult } from "./spawn-broker";
import type { SpawnExecutionResult } from "./spawn-executor";

export * from "./body-builder";
export * from "./spawn-broker";
export * from "./spawn-executor";

export type SpawnRuntimeStatus = "not-run" | "disabled" | "planned";

/** Immutable tick-local evidence; durable reset safety stays in the colonies ledger. */
export interface SpawnRuntimeResult {
  readonly status: SpawnRuntimeStatus;
  readonly broker: SpawnBrokerResult | null;
  readonly execution: readonly SpawnExecutionResult[];
}

export function spawnRuntimeResult(
  status: SpawnRuntimeStatus,
  broker: SpawnBrokerResult | null = null,
  execution: readonly SpawnExecutionResult[] = [],
): SpawnRuntimeResult {
  return deepFreeze({ status, broker, execution: [...execution] });
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
