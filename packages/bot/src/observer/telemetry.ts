import type { CommandExecutionResult } from "../execution";
import type {
  ObserverAttemptSettlement,
  ObserverIntent,
  ObserverRequestDisposition,
} from "./authority";
import { OBSERVER_AUTHORITY_CAPS } from "./authority";
import type { ObserverCommand } from "./executor";

export interface ObserverTelemetry {
  readonly commands: {
    readonly executed: number;
    readonly failed: number;
    readonly rejected: number;
  };
  readonly dispositions: {
    readonly accepted: number;
    readonly deferred: number;
    readonly pending: number;
    readonly rejected: number;
    readonly satisfied: number;
  };
  readonly intents: number;
  readonly settlements: {
    readonly cancelled: number;
    readonly pending: number;
    readonly retries: number;
    readonly settled: number;
  };
  readonly truncated: boolean;
}

/** Fixed-cardinality observer projection. It owns no request, command, or history. */
export function projectObserverTelemetry(input: {
  readonly dispositions: readonly ObserverRequestDisposition[];
  readonly execution: readonly CommandExecutionResult<ObserverCommand>[];
  readonly intents: readonly ObserverIntent[];
  readonly settlements: readonly ObserverAttemptSettlement[];
}): ObserverTelemetry {
  const dispositions = input.dispositions.slice(0, OBSERVER_AUTHORITY_CAPS.requests);
  const execution = input.execution.slice(0, OBSERVER_AUTHORITY_CAPS.observers);
  const intents = input.intents.slice(0, OBSERVER_AUTHORITY_CAPS.observers);
  const settlements = input.settlements.slice(0, OBSERVER_AUTHORITY_CAPS.pendingAttempts);
  return freeze({
    commands: {
      executed: execution.filter(({ status }) => status === "executed").length,
      failed: execution.filter(({ status }) => status === "failed").length,
      rejected: execution.filter(({ status }) => status === "rejected").length,
    },
    dispositions: {
      accepted: dispositions.filter(({ status }) => status === "accepted").length,
      deferred: dispositions.filter(({ status }) => status === "deferred").length,
      pending: dispositions.filter(({ status }) => status === "pending").length,
      rejected: dispositions.filter(({ status }) => status === "rejected").length,
      satisfied: dispositions.filter(({ status }) => status === "satisfied").length,
    },
    intents: intents.length,
    settlements: {
      cancelled: settlements.filter(({ status }) => status === "cancelled").length,
      pending: settlements.filter(({ status }) => status === "pending").length,
      retries: settlements.filter(({ status }) => status === "retry").length,
      settled: settlements.filter(({ status }) => status === "settled").length,
    },
    truncated:
      dispositions.length < input.dispositions.length ||
      execution.length < input.execution.length ||
      intents.length < input.intents.length ||
      settlements.length < input.settlements.length,
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
