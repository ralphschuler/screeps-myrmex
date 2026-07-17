import type { CommandExecutionResult } from "../execution";
import type { IndustryPlan } from "./stock-policy";
import type { TerminalSendCommand } from "./terminal-executor";

export interface IndustryCommandState {
  readonly attempt: number;
  readonly identity: string;
  readonly lastCode: string;
  readonly nextEligibleTick: number;
  readonly status: "active" | "backoff" | "completed" | "retired";
}

export interface IndustryTelemetry {
  readonly accounting: IndustryPlan["accounting"];
  readonly commands: {
    readonly executed: number;
    readonly failed: number;
    readonly rejected: number;
  };
  readonly deferred: number;
  readonly extractionProposals: number;
  readonly sendProposals: number;
  readonly states: readonly IndustryCommandState[];
}

const MAX_STATES = 128;

export function reconcileIndustryCommands(input: {
  readonly plan: IndustryPlan;
  readonly previous: readonly IndustryCommandState[];
  readonly results: readonly CommandExecutionResult<TerminalSendCommand>[];
  readonly tick: number;
}): readonly IndustryCommandState[] {
  const activeIds = new Set(input.plan.sends.map(({ identity }) => identity));
  const states = new Map(input.previous.map((state) => [state.identity, state]));
  for (const state of input.previous)
    if (!activeIds.has(state.identity) && state.status !== "completed")
      states.set(state.identity, { ...state, status: "retired" });
  for (const result of [...input.results].sort((a, b) => a.intentId.localeCompare(b.intentId))) {
    const prior = states.get(result.intentId);
    if (result.status === "executed")
      states.set(result.intentId, {
        attempt: prior?.attempt ?? 0,
        identity: result.intentId,
        lastCode: result.reason,
        nextEligibleTick: input.tick,
        status: "completed",
      });
    else {
      const attempt = Math.min(8, (prior?.attempt ?? 0) + 1);
      states.set(result.intentId, {
        attempt,
        identity: result.intentId,
        lastCode: result.reason,
        nextEligibleTick: safeAdd(input.tick, Math.min(32, 2 ** attempt)),
        status: "backoff",
      });
    }
  }
  return Object.freeze(
    [...states.values()]
      .sort((a, b) => a.identity.localeCompare(b.identity))
      .slice(0, MAX_STATES)
      .map((state) => Object.freeze(state)),
  );
}

export function projectIndustryTelemetry(input: {
  readonly plan: IndustryPlan;
  readonly results: readonly CommandExecutionResult<TerminalSendCommand>[];
  readonly states: readonly IndustryCommandState[];
}): IndustryTelemetry {
  return Object.freeze({
    accounting: input.plan.accounting,
    commands: {
      executed: input.results.filter(({ status }) => status === "executed").length,
      failed: input.results.filter(({ status }) => status === "failed").length,
      rejected: input.results.filter(({ status }) => status === "rejected").length,
    },
    deferred: input.plan.deferrals.reduce((sum, { count }) => sum + count, 0),
    extractionProposals: input.plan.extraction.length,
    sendProposals: input.plan.sends.length,
    states: input.states,
  });
}

export function eligibleIndustrySendIds(
  identities: readonly string[],
  states: readonly IndustryCommandState[],
  tick: number,
): readonly string[] {
  const byId = new Map(states.map((state) => [state.identity, state]));
  return Object.freeze(
    [...identities].sort().filter((identity) => {
      const state = byId.get(identity);
      return (
        state === undefined ||
        state.status === "active" ||
        (state.status === "backoff" && tick >= state.nextEligibleTick)
      );
    }),
  );
}

function safeAdd(value: number, delta: number): number {
  return value <= Number.MAX_SAFE_INTEGER - delta ? value + delta : Number.MAX_SAFE_INTEGER;
}
