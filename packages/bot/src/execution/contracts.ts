export const INTENT_PRIORITY_CLASSES = [
  "safety",
  "defense",
  "survival",
  "replacement",
  "maintenance",
  "growth",
  "speculation",
] as const;

export type IntentPriorityClass = (typeof INTENT_PRIORITY_CLASSES)[number];

export type IntentData =
  null | boolean | number | string | readonly IntentData[] | { readonly [key: string]: IntentData };

export interface IntentPriority {
  readonly class: IntentPriorityClass;
  /** Higher values win within one policy-owned priority class. */
  readonly value: number;
}

export interface IntentBudget {
  /** Stable budget or reservation identifier used for attribution. */
  readonly id: string;
  /** Abstract, non-negative admission units consumed by this intent. */
  readonly cost: number;
}

/**
 * A data-only check against the tick's immutable observation. The arbiter is
 * given a validation adapter; the envelope never closes over live Game data.
 */
export interface IntentPrecondition {
  readonly key: string;
  readonly expected: IntentData;
}

/**
 * The shared, immutable unit exchanged between planners and execution.
 *
 * `id` is deterministic for the proposal and is the final arbitration
 * tie-break. It must therefore include enough scope to deduplicate retries.
 */
export interface IntentEnvelope<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  readonly id: string;
  readonly kind: Kind;
  readonly issuer: string;
  readonly tick: number;
  readonly target: string;
  readonly snapshotRevision: string;
  readonly exclusiveResourceKey: string;
  readonly priority: IntentPriority;
  /** Last tick on which this proposal may be accepted. */
  readonly deadline: number;
  readonly budget: IntentBudget;
  readonly preconditions: readonly IntentPrecondition[];
  readonly payload: Payload;
}

export interface IntentProducer<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  /** Appends one proposal to this system's private, tick-local buffer. */
  submit(intent: IntentEnvelope<Kind, Payload>): void;
}

/**
 * A sealed private producer batch. Publishing is atomic: `commit` makes every
 * proposal visible to arbitration or, if it fails, none of them visible.
 */
export interface StagedIntentBatch {
  readonly count: number;
  commit(): void;
  discard(): void;
}

/**
 * System-owned production scope. Only `producer` is handed to planning code;
 * the runtime owns the stage/commit/discard boundary.
 */
export interface IntentProducerScope<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  readonly systemId: string;
  readonly producer: IntentProducer<Kind, Payload>;
  stage(): StagedIntentBatch;
  /** Idempotently fail-closes an open or staged private buffer. */
  discard(): void;
}

export type PreconditionEvaluation =
  { readonly satisfied: true } | { readonly satisfied: false; readonly detail?: string };

export type PreconditionEvaluator<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> = (
  precondition: IntentPrecondition,
  intent: IntentEnvelope<Kind, Payload>,
) => PreconditionEvaluation;

export type IntentDecisionStatus = "accepted" | "rejected" | "deferred";

export type IntentDecisionReason =
  | "duplicate-id"
  | "not-yet-valid"
  | "expired"
  | "stale-snapshot"
  | "precondition-unavailable"
  | "precondition-failed"
  | "precondition-error"
  | "exclusive-resource-conflict"
  | "capacity-overload"
  | "budget-overload";

export interface AcceptedIntentDecision<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  readonly intent: IntentEnvelope<Kind, Payload>;
  readonly status: "accepted";
  readonly reason: null;
}

export interface UnacceptedIntentDecision<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  readonly intent: IntentEnvelope<Kind, Payload>;
  readonly status: "rejected" | "deferred";
  readonly reason: IntentDecisionReason;
  readonly detail: string | null;
  readonly winnerIntentId: string | null;
}

export type IntentDecision<Kind extends string = string, Payload extends IntentData = IntentData> =
  AcceptedIntentDecision<Kind, Payload> | UnacceptedIntentDecision<Kind, Payload>;

export type ArbitrationOverloadPolicy = "defer" | "reject";

export interface ArbitrationLimits {
  /** Hard cap on committed proposals, and on each private producer buffer. */
  readonly maximumSubmitted: number;
  /** Maximum commands admitted from this channel during one arbitration pass. */
  readonly maximumAccepted: number;
  /** Maximum summed `IntentBudget.cost` admitted during the pass. */
  readonly maximumBudget: number;
  readonly overloadPolicy: ArbitrationOverloadPolicy;
}

export interface ArbitrationRequest<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  readonly tick: number;
  readonly snapshotRevision: string;
  readonly evaluatePrecondition?: PreconditionEvaluator<Kind, Payload>;
}

export interface ArbitrationBatch<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  readonly tick: number;
  readonly submitted: number;
  readonly acceptedBudget: number;
  readonly accepted: readonly IntentEnvelope<Kind, Payload>[];
  /** Exactly one entry for each proposal in a successfully committed batch. */
  readonly decisions: readonly IntentDecision<Kind, Payload>[];
}

export interface IntentArbiter<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  /** Fail-closes unresolved scopes, then seals and consumes committed batches once. */
  arbitrate(request: ArbitrationRequest<Kind, Payload>): ArbitrationBatch<Kind, Payload>;
}

export interface IntentChannel<
  Kind extends string = string,
  Payload extends IntentData = IntentData,
> {
  /** Opens the only producer transaction this system may own on the channel. */
  openProducer(systemId: string): IntentProducerScope<Kind, Payload>;
  readonly arbiter: IntentArbiter<Kind, Payload>;
}
