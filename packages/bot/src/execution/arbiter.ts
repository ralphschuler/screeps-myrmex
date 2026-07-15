import {
  INTENT_PRIORITY_CLASSES,
  type ArbitrationBatch,
  type ArbitrationLimits,
  type ArbitrationRequest,
  type IntentChannel,
  type IntentData,
  type IntentDecision,
  type IntentDecisionReason,
  type IntentEnvelope,
  type IntentProducerScope,
  type PreconditionEvaluator,
  type StagedIntentBatch,
  type UnacceptedIntentDecision,
} from "./contracts";
import { defineIntent } from "./intent";

const priorityRank = new Map(
  INTENT_PRIORITY_CLASSES.map((priorityClass, index) => [priorityClass, index] as const),
);

/** Creates a one-shot, tick-local transactional producer/arbiter channel. */
export function createIntentChannel<Kind extends string, Payload extends IntentData>(
  limits: ArbitrationLimits,
): IntentChannel<Kind, Payload> {
  validateLimits(limits);

  const committedBatches: (readonly IntentEnvelope<Kind, Payload>[])[] = [];
  const openedSystemIds = new Set<string>();
  const unresolvedScopes = new Map<number, () => void>();
  let committedCount = 0;
  let nextScopeId = 0;
  let sealed = false;
  const openProducer = (systemId: string): IntentProducerScope<Kind, Payload> => {
    validateSystemId(systemId);
    if (sealed) {
      throw new Error("intent channel is already finalized");
    }
    if (openedSystemIds.has(systemId)) {
      throw new Error(`intent producer scope already opened for ${systemId}`);
    }
    openedSystemIds.add(systemId);

    const scopeId = nextScopeId;
    nextScopeId += 1;
    let state: "open" | "staged" | "committed" | "discarded" = "open";
    let pending: IntentEnvelope<Kind, Payload>[] = [];
    let stagedEntries: readonly IntentEnvelope<Kind, Payload>[] | null = null;

    const failClose = (): void => {
      if (state === "committed" || state === "discarded") {
        return;
      }
      state = "discarded";
      pending = [];
      stagedEntries = null;
      unresolvedScopes.delete(scopeId);
    };
    unresolvedScopes.set(scopeId, failClose);

    const producer = Object.freeze({
      submit(intent: IntentEnvelope<Kind, Payload>): void {
        if (state !== "open") {
          throw new Error("intent producer scope is already finalized");
        }
        if (pending.length >= limits.maximumSubmitted) {
          throw new Error("intent producer buffer capacity exceeded");
        }
        pending.push(defineIntent(intent));
      },
    });

    const stage = (): StagedIntentBatch => {
      if (state !== "open") {
        throw new Error("intent producer scope may only be staged once");
      }
      stagedEntries = Object.freeze(pending.slice());
      pending = [];
      state = "staged";

      return Object.freeze({
        count: stagedEntries.length,
        commit(): void {
          if (state !== "staged" || stagedEntries === null) {
            throw new Error("staged intent batch may only be committed once");
          }
          if (sealed) {
            throw new Error("intent channel is already finalized");
          }
          if (committedCount + stagedEntries.length > limits.maximumSubmitted) {
            throw new Error("intent channel committed submission capacity exceeded");
          }

          // One shared batch reference is published only after every check has
          // passed. Arbitration never observes a prefix of the staged entries.
          committedBatches.push(stagedEntries);
          committedCount += stagedEntries.length;
          state = "committed";
          stagedEntries = null;
          unresolvedScopes.delete(scopeId);
        },
        discard: failClose,
      });
    };

    return Object.freeze({ systemId, producer, stage, discard: failClose });
  };

  const arbiter = Object.freeze({
    arbitrate(request: ArbitrationRequest<Kind, Payload>): ArbitrationBatch<Kind, Payload> {
      if (sealed) {
        throw new Error("intent channel may only be finalized once");
      }

      // Any producer that did not reach a successful commit is failed closed.
      // This includes a planner that submitted several intents and then threw.
      for (const discard of [...unresolvedScopes.values()]) {
        discard();
      }
      sealed = true;

      const entries: IntentEnvelope<Kind, Payload>[] = [];
      for (const batch of committedBatches) {
        for (const intent of batch) {
          entries.push(intent);
        }
      }
      return arbitrate(entries, request, limits);
    },
  });

  return Object.freeze({ openProducer, arbiter });
}

export function compareIntentPriority<Kind extends string, Payload extends IntentData>(
  left: IntentEnvelope<Kind, Payload>,
  right: IntentEnvelope<Kind, Payload>,
): number {
  return (
    rankOf(left) - rankOf(right) ||
    right.priority.value - left.priority.value ||
    left.deadline - right.deadline ||
    left.budget.cost - right.budget.cost ||
    left.tick - right.tick ||
    compareStableStrings(left.id, right.id)
  );
}

function arbitrate<Kind extends string, Payload extends IntentData>(
  submitted: readonly IntentEnvelope<Kind, Payload>[],
  request: ArbitrationRequest<Kind, Payload>,
  limits: ArbitrationLimits,
): ArbitrationBatch<Kind, Payload> {
  validateRequest(request);
  const ordered = submitted.slice().sort(compareIntentPriority);
  const duplicateIds = findDuplicateIds(ordered);
  const decisions: IntentDecision<Kind, Payload>[] = [];
  const eligible: IntentEnvelope<Kind, Payload>[] = [];

  for (const intent of ordered) {
    if (duplicateIds.has(intent.id)) {
      decisions.push(unaccepted(intent, "rejected", "duplicate-id"));
      continue;
    }
    if (request.tick < intent.tick) {
      decisions.push(unaccepted(intent, "rejected", "not-yet-valid"));
      continue;
    }
    if (request.tick > intent.deadline) {
      decisions.push(unaccepted(intent, "rejected", "expired"));
      continue;
    }
    if (intent.snapshotRevision !== request.snapshotRevision) {
      decisions.push(unaccepted(intent, "rejected", "stale-snapshot"));
      continue;
    }
    const failedPrecondition = evaluatePreconditions(intent, request.evaluatePrecondition);
    if (failedPrecondition !== null) {
      decisions.push(failedPrecondition);
      continue;
    }
    eligible.push(intent);
  }

  const winners: IntentEnvelope<Kind, Payload>[] = [];
  const resourceWinners = new Map<string, string>();
  for (const intent of eligible) {
    const winnerIntentId = resourceWinners.get(intent.exclusiveResourceKey);
    if (winnerIntentId !== undefined) {
      decisions.push(
        unaccepted(
          intent,
          "rejected",
          "exclusive-resource-conflict",
          `exclusive resource won by ${winnerIntentId}`,
          winnerIntentId,
        ),
      );
      continue;
    }
    resourceWinners.set(intent.exclusiveResourceKey, intent.id);
    winners.push(intent);
  }

  const accepted: IntentEnvelope<Kind, Payload>[] = [];
  let acceptedBudget = 0;
  for (const intent of winners) {
    if (accepted.length >= limits.maximumAccepted) {
      decisions.push(overloadDecision(intent, "capacity-overload", limits));
      continue;
    }
    if (acceptedBudget + intent.budget.cost > limits.maximumBudget) {
      decisions.push(overloadDecision(intent, "budget-overload", limits));
      continue;
    }
    accepted.push(intent);
    acceptedBudget += intent.budget.cost;
    decisions.push(Object.freeze({ intent, status: "accepted", reason: null }));
  }

  decisions.sort((left, right) => compareIntentPriority(left.intent, right.intent));
  assertExactlyOneDecision(submitted.length, decisions.length);

  return Object.freeze({
    tick: request.tick,
    submitted: submitted.length,
    acceptedBudget,
    accepted: Object.freeze(accepted),
    decisions: Object.freeze(decisions),
  });
}

function evaluatePreconditions<Kind extends string, Payload extends IntentData>(
  intent: IntentEnvelope<Kind, Payload>,
  evaluator: PreconditionEvaluator<Kind, Payload> | undefined,
): UnacceptedIntentDecision<Kind, Payload> | null {
  if (intent.preconditions.length === 0) {
    return null;
  }
  if (evaluator === undefined) {
    return unaccepted(
      intent,
      "rejected",
      "precondition-unavailable",
      "no precondition evaluator was provided",
    );
  }

  for (const precondition of intent.preconditions) {
    try {
      const evaluation = evaluator(precondition, intent);
      if (!evaluation.satisfied) {
        return unaccepted(
          intent,
          "rejected",
          "precondition-failed",
          boundedText(evaluation.detail ?? precondition.key),
        );
      }
    } catch (error: unknown) {
      return unaccepted(intent, "rejected", "precondition-error", compactError(error));
    }
  }
  return null;
}

function overloadDecision<Kind extends string, Payload extends IntentData>(
  intent: IntentEnvelope<Kind, Payload>,
  reason: Extract<IntentDecisionReason, "capacity-overload" | "budget-overload">,
  limits: ArbitrationLimits,
): UnacceptedIntentDecision<Kind, Payload> {
  return unaccepted(intent, limits.overloadPolicy === "defer" ? "deferred" : "rejected", reason);
}

function unaccepted<Kind extends string, Payload extends IntentData>(
  intent: IntentEnvelope<Kind, Payload>,
  status: "rejected" | "deferred",
  reason: IntentDecisionReason,
  detail: string | null = null,
  winnerIntentId: string | null = null,
): UnacceptedIntentDecision<Kind, Payload> {
  return Object.freeze({ intent, status, reason, detail, winnerIntentId });
}

function findDuplicateIds<Kind extends string, Payload extends IntentData>(
  intents: readonly IntentEnvelope<Kind, Payload>[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const intent of intents) {
    counts.set(intent.id, (counts.get(intent.id) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([intentId]) => intentId),
  );
}

function rankOf<Kind extends string, Payload extends IntentData>(
  intent: IntentEnvelope<Kind, Payload>,
): number {
  return priorityRank.get(intent.priority.class) ?? Number.MAX_SAFE_INTEGER;
}

function compareStableStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateLimits(limits: ArbitrationLimits): void {
  if (!Number.isSafeInteger(limits.maximumSubmitted) || limits.maximumSubmitted < 0) {
    throw new Error("maximumSubmitted must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limits.maximumAccepted) || limits.maximumAccepted < 0) {
    throw new Error("maximumAccepted must be a non-negative safe integer");
  }
  if (limits.maximumAccepted > limits.maximumSubmitted) {
    throw new Error("maximumAccepted must not exceed maximumSubmitted");
  }
  if (!Number.isFinite(limits.maximumBudget) || limits.maximumBudget < 0) {
    throw new Error("maximumBudget must be a non-negative finite number");
  }
}

function validateRequest<Kind extends string, Payload extends IntentData>(
  request: ArbitrationRequest<Kind, Payload>,
): void {
  if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
    throw new Error("arbitration tick must be a non-negative safe integer");
  }
  if (
    request.snapshotRevision.trim().length === 0 ||
    request.snapshotRevision !== request.snapshotRevision.trim()
  ) {
    throw new Error("arbitration snapshot revision must be non-empty and trimmed");
  }
}

function validateSystemId(systemId: string): void {
  if (systemId.length === 0 || systemId.length > 200 || systemId !== systemId.trim()) {
    throw new Error(
      "intent producer system id must be non-empty, trimmed, and at most 200 characters",
    );
  }
}

function assertExactlyOneDecision(submitted: number, decided: number): void {
  if (submitted !== decided) {
    throw new Error(
      `arbitration invariant failed: ${String(submitted)} submissions produced ${String(decided)} decisions`,
    );
  }
}

function compactError(error: unknown): string {
  return boundedText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

function boundedText(value: string): string {
  return value.slice(0, 300);
}
