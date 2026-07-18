import type { CommandExecutionResult } from "../execution";
import type { MatureCommand } from "./mature-executor";
import {
  hasIndustrySettlementAccounting,
  industrySettlementAccountingRow,
  sumIndustrySettlementAccounting,
  type IndustrySettlementAccountingRow,
} from "./settlement-accounting";
import {
  MATURE_RUNTIME_CAPS,
  type MatureAttemptSettlement,
  type MatureCommandIntent,
} from "./mature-runtime";

export interface MatureCommandTelemetry {
  readonly accounting?: {
    readonly factory: IndustrySettlementAccountingRow;
    readonly powerProcessing: IndustrySettlementAccountingRow;
  };
  readonly commands: {
    readonly executed: number;
    readonly failed: number;
    readonly rejected: number;
  };
  readonly intents: {
    readonly factory: number;
    readonly powerProcessing: number;
    readonly total: number;
  };
  readonly settlements: {
    readonly cancelled: number;
    readonly pending: number;
    readonly retries: number;
  };
  readonly truncated: boolean;
}

/** Fixed-cardinality observer projection; it owns no gameplay decision or history. */
export function projectMatureCommandTelemetry(input: {
  readonly execution: readonly CommandExecutionResult<MatureCommand>[];
  readonly intents: readonly MatureCommandIntent[];
  readonly settlements: readonly MatureAttemptSettlement[];
}): MatureCommandTelemetry {
  const execution = input.execution.slice(0, MATURE_RUNTIME_CAPS.maximumCandidates);
  const intents = input.intents.slice(0, MATURE_RUNTIME_CAPS.maximumCandidates);
  const settlements = input.settlements.slice(0, MATURE_RUNTIME_CAPS.maximumPendingAttempts);
  const accounting = {
    factory: sumIndustrySettlementAccounting(
      settlements
        .filter(({ kind, status }) => kind === "factory" && status === "settled")
        .map(({ accounting: value }) => value),
    ),
    powerProcessing: sumIndustrySettlementAccounting(
      settlements
        .filter(({ kind, status }) => kind === "power-processing" && status === "settled")
        .map(({ accounting: value }) => value),
    ),
  };
  const hasAccounting =
    hasIndustrySettlementAccounting(accounting.factory) ||
    hasIndustrySettlementAccounting(accounting.powerProcessing);
  return freeze({
    ...(hasAccounting
      ? {
          accounting: {
            factory: industrySettlementAccountingRow(accounting.factory),
            powerProcessing: industrySettlementAccountingRow(accounting.powerProcessing),
          },
        }
      : {}),
    commands: {
      executed: execution.filter(({ status }) => status === "executed").length,
      failed: execution.filter(({ status }) => status === "failed").length,
      rejected: execution.filter(({ status }) => status === "rejected").length,
    },
    intents: {
      factory: intents.filter(({ kind }) => kind === "factory.produce").length,
      powerProcessing: intents.filter(({ kind }) => kind === "power-spawn.process-power").length,
      total: intents.length,
    },
    settlements: {
      cancelled: settlements.filter(({ status }) => status === "cancelled").length,
      pending: settlements.filter(({ status }) => status === "pending").length,
      retries: settlements.filter(({ status }) => status === "retry").length,
    },
    truncated:
      input.execution.length > execution.length ||
      input.intents.length > intents.length ||
      input.settlements.length > settlements.length,
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
