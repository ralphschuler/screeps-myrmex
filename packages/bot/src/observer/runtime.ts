import type { CommandExecutionResult } from "../execution";
import type {
  MatureMechanicsCatalog,
  MatureStructureCapability,
} from "../industry/mature-capabilities";
import type { WorldSnapshot } from "../world/snapshot";
import {
  createPendingObserverAttempt,
  markObserverAttemptRetryReady,
  projectObserverIntents,
  reconcilePendingObserverAttempts,
  type ObservationRequestV1,
  type ObserverAttemptSettlement,
  type ObserverAuthorization,
  type ObserverProjectionResult,
  type PendingObserverAttempt,
} from "./authority";
import type { ObserverCommand } from "./executor";

export interface ObserverRuntimeProjection {
  readonly arbitration: ObserverProjectionResult;
  readonly authorizations: readonly ObserverAuthorization[];
  readonly settlements: readonly ObserverAttemptSettlement[];
}

export function emptyObserverRuntimeProjection(): ObserverRuntimeProjection {
  return freeze({
    arbitration: { dispositions: [], intents: [], reason: null, status: "ready" },
    authorizations: [],
    settlements: [],
  });
}

export function composeObserverRuntime(input: {
  readonly authorizations: readonly ObserverAuthorization[];
  readonly capabilities: readonly MatureStructureCapability[];
  readonly catalog: MatureMechanicsCatalog;
  readonly pendingAttempts: readonly PendingObserverAttempt[];
  readonly requests: readonly ObservationRequestV1[];
  readonly snapshot: WorldSnapshot;
  readonly snapshotRevision: string;
}): ObserverRuntimeProjection {
  const arbitration = projectObserverIntents(input);
  const settlements = reconcilePendingObserverAttempts({
    authorizations: input.authorizations,
    pendingAttempts: input.pendingAttempts,
    snapshot: input.snapshot,
  });
  return freeze({ arbitration, authorizations: input.authorizations, settlements });
}

export function settleObserverRuntime(input: {
  readonly execution: readonly CommandExecutionResult<ObserverCommand>[];
  readonly previousAttempts: readonly PendingObserverAttempt[];
  readonly projection: ObserverRuntimeProjection;
}): readonly PendingObserverAttempt[] {
  const settlements = new Map(
    input.projection.settlements.map((settlement) => [settlement.attemptId, settlement]),
  );
  let attempts = input.previousAttempts.flatMap((attempt): readonly PendingObserverAttempt[] => {
    const settlement = settlements.get(attempt.attemptId);
    if (settlement === undefined || settlement.status === "pending") return [attempt];
    if (settlement.status !== "retry") return [];
    const ready = markObserverAttemptRetryReady(attempt, settlement);
    return ready === null ? [] : [ready];
  });
  for (const result of input.execution) {
    const intent = input.projection.arbitration.intents.find(({ id }) => id === result.intentId);
    if (intent === undefined) continue;
    const retry = attempts.find(
      (attempt) =>
        attempt.retryReady === true &&
        attempt.requestId === intent.payload.requestId &&
        attempt.requestRevision === intent.payload.requestRevision,
    );
    const pending = createPendingObserverAttempt(intent, result.reason);
    if (pending === null) continue;
    attempts = attempts.filter((attempt) => attempt !== retry);
    attempts.push(pending);
  }
  return freeze(attempts.sort((a, b) => a.attemptId.localeCompare(b.attemptId)));
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
