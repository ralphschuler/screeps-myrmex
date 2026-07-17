import type {
  LinkTransferAttemptCode,
  LinkTransferDecision,
  LinkTransferExecutionResult,
} from "./contracts";

export interface LinkExecutionAdapter {
  isCurrentLayoutRevision(layoutRevision: string): boolean;
  resolveLink(id: string): StructureLink | null;
}

/** Sole live-command owner for accepted link transfers. */
export class LinkExecutor {
  private readonly failures = new Map<string, { attempt: number; nextEligibleTick: number }>();

  execute(
    decisions: readonly LinkTransferDecision[],
    adapter: LinkExecutionAdapter,
    tick = 0,
  ): readonly LinkTransferExecutionResult[] {
    const used = new Set<string>();
    return Object.freeze(
      [...decisions]
        .sort((a, b) => a.proposalId.localeCompare(b.proposalId))
        .map((decision) => {
          if (used.has(decision.sourceLinkId))
            return result(decision, false, "UNEXPECTED", "duplicate-source");
          used.add(decision.sourceLinkId);
          const key = failureKey(decision);
          const prior = this.failures.get(key);
          if (prior !== undefined && tick < prior.nextEligibleTick)
            return result(decision, false, "DEFERRED_BACKOFF", "command-backoff");
          const execution = this.executeOne(decision, adapter);
          if (execution.code === "OK") this.failures.delete(key);
          else if (execution.called || execution.fault === "adapter-fault")
            this.recordFailure(key, prior?.attempt ?? 0, tick);
          return execution;
        }),
    );
  }

  private recordFailure(key: string, priorAttempt: number, tick: number): void {
    const attempt = Math.min(8, priorAttempt + 1);
    const delay = Math.min(32, 2 ** attempt);
    this.failures.delete(key);
    this.failures.set(key, { attempt, nextEligibleTick: safeAdd(tick, delay) });
    while (this.failures.size > 128) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  private executeOne(
    decision: LinkTransferDecision,
    adapter: LinkExecutionAdapter,
  ): LinkTransferExecutionResult {
    try {
      if (!adapter.isCurrentLayoutRevision(decision.layoutRevision))
        return result(decision, false, "ERR_INVALID_TARGET", "stale-layout");
      const source = adapter.resolveLink(decision.sourceLinkId);
      if (source === null)
        return result(decision, false, "ERR_INVALID_TARGET", "source-unavailable");
      const target = adapter.resolveLink(decision.targetLinkId);
      if (target === null)
        return result(decision, false, "ERR_INVALID_TARGET", "target-unavailable");
      const code = normalizeReturnCode(source.transferEnergy(target, decision.sentAmount));
      return result(decision, true, code, code === "UNEXPECTED" ? "adapter-fault" : null);
    } catch {
      return result(decision, false, "UNEXPECTED", "adapter-fault");
    }
  }
}

function failureKey(decision: LinkTransferDecision): string {
  return `${decision.layoutRevision}\u0000${decision.sourceLinkId}\u0000${decision.targetLinkId}`;
}

function safeAdd(value: number, delta: number): number {
  return value <= Number.MAX_SAFE_INTEGER - delta ? value + delta : Number.MAX_SAFE_INTEGER;
}

function normalizeReturnCode(code: number): LinkTransferAttemptCode {
  if (code === 0) return "OK";
  if (code === -1) return "ERR_NOT_OWNER";
  if (code === -6) return "ERR_NOT_ENOUGH_RESOURCES";
  if (code === -7) return "ERR_INVALID_TARGET";
  if (code === -8) return "ERR_FULL";
  if (code === -9) return "ERR_NOT_IN_RANGE";
  if (code === -10) return "ERR_INVALID_ARGS";
  if (code === -11) return "ERR_TIRED";
  if (code === -14) return "ERR_RCL_NOT_ENOUGH";
  return "UNEXPECTED";
}

function result(
  decision: LinkTransferDecision,
  called: boolean,
  code: LinkTransferAttemptCode,
  fault: LinkTransferExecutionResult["fault"],
): LinkTransferExecutionResult {
  const succeeded = called && code === "OK";
  return Object.freeze({
    actualDeliveredAmount: succeeded ? decision.deliveredAmount : 0,
    actualLostAmount: succeeded ? decision.lostAmount : 0,
    actualSentAmount: succeeded ? decision.sentAmount : 0,
    called,
    code,
    decision,
    fault,
  });
}
