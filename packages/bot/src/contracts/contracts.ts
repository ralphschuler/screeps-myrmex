import { INTENT_PRIORITY_CLASSES, type IntentPriority } from "../execution/contracts";
import type { CreepSnapshot, PositionSnapshot } from "../world/snapshot";

export const CONTRACT_LEDGER_SCHEMA_VERSION = 1 as const;

export const MAX_ACTIVE_CONTRACTS = 256;
export const MAX_CONTRACT_OUTCOMES = 8;
export const MAX_CONTRACT_HISTORY = 16;
export const MAX_CONTRACT_ISSUERS = 128;
export const MAX_CONTRACT_REQUESTS_PER_TICK = 128;
export const MAX_CONTRACT_TRANSITIONS_PER_TICK = 128;
export const MAX_CONTRACT_FUNDING_AUTHORIZATIONS = 512;
export const MAX_ALLOCATION_CONTRACTS = 64;
export const MAX_ALLOCATION_ACTORS = 64;
export const MAX_ALLOCATION_PAIRS = 4_096;
export const MAX_SAFE_IDLE_ACTORS = 64;
export const MAX_POPULATION_LOADS = 64;

export interface NormalizedPopulationLoad {
  readonly backlogWorkTicks: number;
  readonly category: string;
  readonly colonyId: string;
  readonly contractId: string;
  readonly measuredWorkTicks: number;
  readonly minimumCapability: CapabilityVector;
  readonly objectiveId: string;
  readonly reservationId: string;
  readonly revision: number;
  readonly sourceCapacityWorkTicks: number;
  readonly travelTicks: number;
  readonly mode?: "cyclic" | "logistics" | "stationary";
}

export interface ContractPopulationView {
  readonly loads: readonly NormalizedPopulationLoad[];
  readonly status: "ready" | "unavailable";
}

export const WORK_CONTRACT_KINDS = [
  "harvest",
  "fill",
  "defend",
  "haul",
  "repair",
  "build",
  "upgrade",
  "scout",
  "other",
] as const;

export type WorkContractKind = (typeof WORK_CONTRACT_KINDS)[number];

export const WORK_CONTRACT_STATES = [
  "proposed",
  "funded",
  "assigned",
  "active",
  "suspended",
  "completed",
  "cancelled",
  "expired",
  "failed",
] as const;

export type WorkContractState = (typeof WORK_CONTRACT_STATES)[number];
export type ActiveWorkContractState = Exclude<
  WorkContractState,
  "completed" | "cancelled" | "expired" | "failed"
>;
export type TerminalWorkContractState = Extract<
  WorkContractState,
  "completed" | "cancelled" | "expired" | "failed"
>;

export interface CapabilityVector {
  readonly attack: number;
  readonly carry: number;
  readonly claim: number;
  readonly heal: number;
  readonly move: number;
  readonly rangedAttack: number;
  readonly tough: number;
  readonly work: number;
}

export const CAPABILITY_KEYS = [
  "attack",
  "carry",
  "claim",
  "heal",
  "move",
  "rangedAttack",
  "tough",
  "work",
] as const satisfies readonly (keyof CapabilityVector)[];

export interface ContractOwnerScope {
  readonly id: string;
  readonly kind: "colony" | "empire" | "operation";
}

/** Stable BudgetLedger issuer key. The live reservation revision is deliberately not persisted. */
export interface ContractBudgetBinding {
  readonly category: string;
  readonly issuer: string;
}

export const CONTRACT_FUNDING_AUTHORIZATION_STATUSES = [
  "pending",
  "active",
  "consumed",
  "released",
  "expired",
] as const;

export type ContractFundingAuthorizationStatus =
  (typeof CONTRACT_FUNDING_AUTHORIZATION_STATUSES)[number];

export interface ContractFundingAuthorization {
  readonly category: string;
  readonly colonyId: string;
  readonly expiresAt: number;
  readonly issuer: string;
  readonly reservationId: string;
  readonly revision: number;
  readonly status: ContractFundingAuthorizationStatus;
}

export interface ContractFundingOwner {
  readonly id: string;
  readonly visibility: "unknown" | "visible";
}

export type ContractFundingView =
  | {
      readonly authorizations: readonly ContractFundingAuthorization[];
      readonly owners: readonly ContractFundingOwner[];
      readonly status: "ready";
    }
  | {
      readonly reason:
        | "colony-owner-future-schema"
        | "colony-owner-malformed"
        | "colony-owner-unavailable"
        | "colony-planning-not-run";
      readonly status: "unavailable";
    };

export type ContractFundingDecisionReason =
  | "authorized"
  | "authorization-unavailable"
  | "owner-not-colony"
  | "owner-observation-unknown"
  | "reservation-expired"
  | "reservation-inactive"
  | "reservation-missing";

export interface ContractFundingDecision {
  readonly contractId: string;
  readonly reason: ContractFundingDecisionReason;
  readonly reservationId: string | null;
  readonly status: "authorized" | "denied" | "unavailable";
}

export interface ContractConditionRefs {
  readonly cancellation: string | null;
  readonly failure: string | null;
  readonly success: string;
}

export interface ContractLeasePolicy {
  /** Number of ticks from assignment through the last valid lease tick. */
  readonly duration: number;
  readonly switchingPenalty: number;
  readonly ttlSafetyMargin: number;
}

/** Versioned, data-only authorization for one scoped primary creep action. */
export const CONTRACT_EXECUTION_TERM_VERSION = 1 as const;
export const CONTRACT_EXECUTION_TERM_VERSION_V2 = 2 as const;
export const CONTRACT_EXECUTION_TERM_VERSION_V3 = 3 as const;

export const CONTRACT_EXECUTION_ACTIONS = [
  "build",
  "harvest",
  "pickup",
  "repair",
  "transfer",
  "upgrade-controller",
  "withdraw",
] as const;

export type ContractExecutionAction = (typeof CONTRACT_EXECUTION_ACTIONS)[number];

export const CONTRACT_EXECUTION_DISPOSITIONS = [
  "continuous",
  "target-depleted",
  "target-full",
  "work-complete",
] as const;

export type ContractExecutionDisposition = (typeof CONTRACT_EXECUTION_DISPOSITIONS)[number];

/**
 * Terms a lease agent may consume. `targetId` remains the primary action target; `counterpartId`
 * identifies the other endpoint of a source/sink relationship when a later agent needs it.
 */
export interface ContractExecutionTermsV1 {
  readonly action: ContractExecutionAction;
  readonly completion: ContractExecutionDisposition;
  /** Repair-only observed hit-point threshold; null preserves full-hit completion. */
  readonly completionHits?: number | null;
  readonly counterpartId: string | null;
  readonly resourceType: ResourceConstant | null;
  readonly version: typeof CONTRACT_EXECUTION_TERM_VERSION;
}
export interface ContractExecutionTermsV2 {
  readonly action: "harvest";
  readonly completion: ContractExecutionDisposition;
  readonly counterpartId: string | null;
  readonly resourceType: null;
  readonly version: typeof CONTRACT_EXECUTION_TERM_VERSION_V2;
  readonly workPosition: PositionSnapshot;
}
export interface ContractExecutionTermsV3 {
  readonly action: "pickup" | "transfer" | "withdraw";
  readonly completion: ContractExecutionDisposition;
  readonly counterpartId: string;
  readonly flowId: string;
  readonly recommendedCarry: number;
  readonly recommendedMove: number;
  readonly reservedAmount: number;
  readonly resourceType: ResourceConstant;
  readonly stage: "acquire" | "deliver";
  readonly version: typeof CONTRACT_EXECUTION_TERM_VERSION_V3;
}
export type ContractExecutionTerms =
  ContractExecutionTermsV1 | ContractExecutionTermsV2 | ContractExecutionTermsV3;

export interface WorkContractRequest {
  readonly budgetBinding: ContractBudgetBinding;
  readonly conditions: ContractConditionRefs;
  /** Inclusive last tick on which travel and modeled work may finish. */
  readonly deadline: number;
  /** Absent only for legacy contracts that predate executable lease terms. */
  readonly execution?: ContractExecutionTerms;
  readonly earliestStart: number;
  readonly estimatedWorkTicks: number;
  /** First tick on which unfinished work must become expired. */
  readonly expiresAt: number;
  readonly issuer: string;
  readonly issuerKey: string;
  /** Monotonic issuance coordinate owned by `issuer`; retired coordinates never reopen. */
  readonly issuerSequence: number;
  readonly kind: WorkContractKind;
  readonly leasePolicy: ContractLeasePolicy;
  readonly maxAssignmentCost: number;
  readonly owner: ContractOwnerScope;
  readonly preconditionKeys: readonly string[];
  readonly priority: IntentPriority;
  readonly quantity: number;
  readonly range: number;
  readonly requiredCapability: CapabilityVector;
  readonly target: PositionSnapshot;
  readonly targetId: string | null;
}

export interface ContractLease {
  readonly actorId: string;
  readonly actorName: string;
  readonly assignedAt: number;
  readonly assignmentCost: number;
  /** First tick on which this lease is invalid. */
  readonly expiresAt: number;
  readonly travelTicks: number;
}

export interface ContractHistoryEvent {
  readonly from: WorkContractState | null;
  readonly reason: string;
  readonly tick: number;
  readonly to: WorkContractState;
}

export interface WorkContractRecord extends WorkContractRequest {
  readonly id: string;
  readonly history: readonly ContractHistoryEvent[];
  readonly lease: ContractLease | null;
  readonly requestSignature: string;
  readonly revision: number;
  readonly state: ActiveWorkContractState;
}

/** A bounded projection of a leased record; raw contract-owner bytes never leave the authority. */
export interface LeasedWorkExecution {
  readonly actorId: string;
  readonly actorName: string;
  readonly contractId: string;
  readonly deadline: number;
  readonly execution: ContractExecutionTerms;
  readonly expiresAt: number;
  readonly leaseExpiresAt: number;
  /** Strategy-owned priority copied into the sanitized agent projection. */
  readonly priority: IntentPriority;
  readonly quantity: number;
  readonly range: number;
  readonly revision: number;
  /** A lease can only remain assigned or active; other states clear it in the ledger. */
  readonly state: "assigned" | "active";
  readonly target: PositionSnapshot;
  readonly targetId: string;
}

export interface ContractExecutionView {
  readonly leases: readonly LeasedWorkExecution[];
  readonly status: "ready" | "unavailable";
}

/** Bounded, data-only active-contract projection for planners that must renew or retire work. */
export interface ContractPlanningRecord {
  readonly budgetBinding: ContractBudgetBinding;
  readonly contractId: string;
  readonly execution: ContractExecutionTerms;
  readonly issuer: string;
  readonly owner: ContractOwnerScope;
  /** Retry evidence derived by ContractLedger from bounded durable transition history. */
  readonly repairRetry?: { readonly attempts: number; readonly eligibleAt: number } | null;
  readonly state: ActiveWorkContractState;
  readonly targetId: string;
}

export interface ContractPlanningView {
  readonly contracts: readonly ContractPlanningRecord[];
  readonly status: "ready" | "unavailable";
}

export function emptyContractPlanningView(
  status: ContractPlanningView["status"] = "unavailable",
): ContractPlanningView {
  return Object.freeze({ contracts: Object.freeze([]), status });
}

export function emptyContractExecutionView(
  status: ContractExecutionView["status"] = "unavailable",
): ContractExecutionView {
  return Object.freeze({ leases: Object.freeze([]), status });
}

export interface ContractOutcome {
  readonly id: string;
  readonly issuer: string;
  readonly issuerKey: string;
  readonly issuerSequence: number;
  readonly reason: string;
  readonly requestSignature: string;
  readonly revision: number;
  readonly state: TerminalWorkContractState;
  readonly tick: number;
}

export interface ContractIssuerFrontier {
  readonly issuer: string;
  /** Highest terminal issuance coordinate observed for this issuer. */
  readonly retiredThrough: number;
}

export interface ContractLedgerStateV1 {
  readonly active: readonly WorkContractRecord[];
  readonly issuerFrontiers: readonly ContractIssuerFrontier[];
  readonly outcomes: readonly ContractOutcome[];
  readonly schemaVersion: typeof CONTRACT_LEDGER_SCHEMA_VERSION;
}

export interface ContractTransitionRequest {
  readonly contractId: string;
  readonly reason: string;
  readonly tick: number;
  readonly to: WorkContractState;
}

export interface WorkforceActor {
  readonly capability: CapabilityVector;
  readonly id: string;
  /** Current energy is an optional, tick-local allocation predicate; it is never persisted. */
  readonly energy?: number;
  /** Null means an unbounded or unknown store; undefined preserves legacy pure-fixture behavior. */
  readonly freeCapacity?: number | null;
  /** Current observed fatigue; optional only for pure legacy fixtures. */
  readonly fatigue?: number;
  readonly name: string;
  /** Conservative fatigue-generating body weight, including inactive and empty CARRY parts. */
  readonly movementWeight?: number;
  readonly pos: PositionSnapshot;
  readonly spawning: boolean;
  readonly ticksToLive: number | null;
}

export class ContractValidationError extends Error {
  public readonly code: string;
  public readonly path: string;

  public constructor(code: string, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
    this.code = code;
    this.path = path;
  }
}

export function createEmptyContractLedgerState(): ContractLedgerStateV1 {
  return Object.freeze({
    active: Object.freeze([]),
    issuerFrontiers: Object.freeze([]),
    outcomes: Object.freeze([]),
    schemaVersion: CONTRACT_LEDGER_SCHEMA_VERSION,
  });
}

export function contractIdFor(issuer: string, issuerKey: string, issuerSequence: number): string {
  validateBoundedString(issuer, "$.issuer", 1, 128);
  validateBoundedString(issuerKey, "$.issuerKey", 1, 256);
  const sequence = nonNegativeInteger(issuerSequence, "$.issuerSequence");
  return `contract:${String(issuer.length)}:${issuer}${String(sequence)}:${String(issuerKey.length)}:${issuerKey}`;
}

/** One live BudgetLedger issuer grant may authorize at most one active contract. */
export function contractFundingBindingKey(
  contract: Pick<WorkContractRequest, "budgetBinding" | "owner">,
): string {
  const { category, issuer } = contract.budgetBinding;
  const { id, kind } = contract.owner;
  return `${String(kind.length)}:${kind}${String(id.length)}:${id}${String(category.length)}:${category}${String(issuer.length)}:${issuer}`;
}

export function normalizeContractRequest(request: WorkContractRequest): WorkContractRequest {
  validateBoundedString(request.issuer, "$.issuer", 1, 128);
  validateBoundedString(request.issuerKey, "$.issuerKey", 1, 256);
  const issuerSequence = nonNegativeInteger(request.issuerSequence, "$.issuerSequence");
  const budgetBinding = {
    category: validateBoundedString(
      request.budgetBinding.category,
      "$.budgetBinding.category",
      1,
      64,
    ),
    issuer: validateBoundedString(request.budgetBinding.issuer, "$.budgetBinding.issuer", 1, 128),
  };
  validateBoundedString(request.owner.id, "$.owner.id", 1, 128);
  if (!(["colony", "empire", "operation"] as const).includes(request.owner.kind)) {
    invalid("invalid-owner-kind", "$.owner.kind", "must be a supported owner scope");
  }
  if (!WORK_CONTRACT_KINDS.includes(request.kind)) {
    invalid("invalid-kind", "$.kind", "must be a supported work kind");
  }

  const priority = normalizePriority(request.priority);
  const requiredCapability = normalizeCapability(
    request.requiredCapability,
    "$.requiredCapability",
  );
  if (capabilityTotal(requiredCapability) === 0) {
    invalid("empty-capability", "$.requiredCapability", "must require at least one active part");
  }

  const earliestStart = nonNegativeInteger(request.earliestStart, "$.earliestStart");
  const deadline = nonNegativeInteger(request.deadline, "$.deadline");
  const expiresAt = nonNegativeInteger(request.expiresAt, "$.expiresAt");
  if (earliestStart > deadline) {
    invalid("invalid-time-window", "$.deadline", "must not precede earliestStart");
  }
  if (expiresAt <= deadline) {
    invalid("invalid-expiry", "$.expiresAt", "must be after the inclusive deadline");
  }

  const preconditionKeys = normalizeStringSet(request.preconditionKeys, "$.preconditionKeys", 16);
  const success = validateBoundedString(request.conditions.success, "$.conditions.success", 1, 128);
  const cancellation = nullableBoundedString(
    request.conditions.cancellation,
    "$.conditions.cancellation",
    128,
  );
  const failure = nullableBoundedString(request.conditions.failure, "$.conditions.failure", 128);
  const target = normalizePosition(request.target, "$.target");
  const targetId = nullableBoundedString(request.targetId, "$.targetId", 128);
  const execution =
    request.execution === undefined
      ? undefined
      : normalizeExecutionTerms(request.execution, request.kind, targetId);

  return deepFreeze({
    budgetBinding,
    conditions: { cancellation, failure, success },
    deadline,
    ...(execution === undefined ? {} : { execution }),
    earliestStart,
    estimatedWorkTicks: positiveInteger(request.estimatedWorkTicks, "$.estimatedWorkTicks"),
    expiresAt,
    issuer: request.issuer,
    issuerKey: request.issuerKey,
    issuerSequence,
    kind: request.kind,
    leasePolicy: {
      duration: positiveInteger(request.leasePolicy.duration, "$.leasePolicy.duration"),
      switchingPenalty: nonNegativeInteger(
        request.leasePolicy.switchingPenalty,
        "$.leasePolicy.switchingPenalty",
      ),
      ttlSafetyMargin: nonNegativeInteger(
        request.leasePolicy.ttlSafetyMargin,
        "$.leasePolicy.ttlSafetyMargin",
      ),
    },
    maxAssignmentCost: nonNegativeInteger(request.maxAssignmentCost, "$.maxAssignmentCost"),
    owner: { id: request.owner.id, kind: request.owner.kind },
    preconditionKeys,
    priority,
    quantity: positiveInteger(request.quantity, "$.quantity"),
    range: integerInRange(request.range, "$.range", 0, 50),
    requiredCapability,
    target,
    targetId,
  });
}

export function requestSignature(request: WorkContractRequest): string {
  const normalized = normalizeContractRequest(request);
  return JSON.stringify(normalized);
}

export function workforceActorFromCreep(creep: CreepSnapshot): WorkforceActor {
  return deepFreeze({
    capability: {
      attack: creep.body.attack.active,
      carry: creep.body.carry.active,
      claim: creep.body.claim.active,
      heal: creep.body.heal.active,
      move: creep.body.move.active,
      rangedAttack: creep.body.rangedAttack.active,
      tough: creep.body.tough.active,
      work: creep.body.work.active,
    },
    id: creep.id,
    energy:
      creep.store.resources.find(({ resourceType }) => resourceType === "energy")?.amount ?? 0,
    freeCapacity: creep.store.freeCapacity,
    fatigue: creep.fatigue,
    name: creep.name,
    movementWeight: Math.max(0, creep.body.size - creep.body.move.total),
    pos: { ...creep.pos },
    spawning: creep.spawning,
    ticksToLive: creep.ticksToLive,
  });
}

export function capabilitySatisfies(
  available: CapabilityVector,
  required: CapabilityVector,
): boolean {
  return CAPABILITY_KEYS.every((key) => available[key] >= required[key]);
}

export function capabilitySurplus(available: CapabilityVector, required: CapabilityVector): number {
  return CAPABILITY_KEYS.reduce(
    (total, key) => total + Math.max(0, available[key] - required[key]),
    0,
  );
}

export function compareContractPriority(
  left: Pick<WorkContractRecord, "deadline" | "id" | "kind" | "priority">,
  right: Pick<WorkContractRecord, "deadline" | "id" | "kind" | "priority">,
): number {
  const classDifference =
    INTENT_PRIORITY_CLASSES.indexOf(left.priority.class) -
    INTENT_PRIORITY_CLASSES.indexOf(right.priority.class);
  if (classDifference !== 0) {
    return classDifference;
  }

  const kindDifference = contractKindRank(left.kind) - contractKindRank(right.kind);
  if (kindDifference !== 0) {
    return kindDifference;
  }

  return (
    right.priority.value - left.priority.value ||
    left.deadline - right.deadline ||
    compareStrings(left.id, right.id)
  );
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contractKindRank(kind: WorkContractKind): number {
  if (kind === "harvest") {
    return 0;
  }
  if (kind === "fill") {
    return 1;
  }
  return 2 + WORK_CONTRACT_KINDS.indexOf(kind);
}

function normalizePriority(priority: IntentPriority): IntentPriority {
  if (!INTENT_PRIORITY_CLASSES.includes(priority.class)) {
    invalid("invalid-priority-class", "$.priority.class", "must be a shared priority class");
  }
  return {
    class: priority.class,
    value: integerInRange(priority.value, "$.priority.value", 0, 1_000_000),
  };
}

function normalizeCapability(value: CapabilityVector, path: string): CapabilityVector {
  const normalized = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, integerInRange(value[key], `${path}.${key}`, 0, 50)]),
  ) as unknown as CapabilityVector;
  if (capabilityTotal(normalized) > 50) {
    invalid("capability-too-large", path, "may require at most 50 body parts");
  }
  return normalized;
}

function capabilityTotal(value: CapabilityVector): number {
  return CAPABILITY_KEYS.reduce((total, key) => total + value[key], 0);
}

function normalizePosition(value: PositionSnapshot, path: string): PositionSnapshot {
  return {
    roomName: validateBoundedString(value.roomName, `${path}.roomName`, 1, 64),
    x: integerInRange(value.x, `${path}.x`, 0, 49),
    y: integerInRange(value.y, `${path}.y`, 0, 49),
  };
}

function normalizeExecutionTerms(
  value: Readonly<{
    readonly action: unknown;
    readonly completion: unknown;
    readonly completionHits?: unknown;
    readonly counterpartId: unknown;
    readonly resourceType: unknown;
    readonly flowId?: unknown;
    readonly recommendedCarry?: unknown;
    readonly recommendedMove?: unknown;
    readonly reservedAmount?: unknown;
    readonly stage?: unknown;
    readonly version: unknown;
    readonly workPosition?: unknown;
  }>,
  kind: WorkContractKind,
  targetId: string | null,
): ContractExecutionTerms {
  if (targetId === null) {
    invalid("execution-target-required", "$.targetId", "must identify the action target");
  }
  if (
    typeof value.action !== "string" ||
    !CONTRACT_EXECUTION_ACTIONS.includes(value.action as ContractExecutionAction)
  ) {
    invalid("invalid-execution-action", "$.execution.action", "must be a supported action");
  }
  const action = value.action as ContractExecutionAction;
  if (
    typeof value.completion !== "string" ||
    !CONTRACT_EXECUTION_DISPOSITIONS.includes(value.completion as ContractExecutionDisposition)
  ) {
    invalid(
      "invalid-execution-completion",
      "$.execution.completion",
      "must be a supported disposition",
    );
  }
  if (value.version !== 1 && value.version !== 2 && value.version !== 3) {
    invalid("invalid-execution-version", "$.execution.version", "must equal 1, 2, or 3");
  }
  if (!actionMatchesContractKind(action, kind)) {
    invalid("execution-kind-mismatch", "$.execution.action", "is not authorized by contract kind");
  }
  const completion = value.completion as ContractExecutionDisposition;
  const completionHits =
    value.completionHits === undefined || value.completionHits === null
      ? null
      : positiveInteger(value.completionHits, "$.execution.completionHits");
  if (action !== "repair" && completionHits !== null) {
    invalid(
      "execution-completion-hits-mismatch",
      "$.execution.completionHits",
      "is only authorized for repair actions",
    );
  }
  const counterpartId = nullableBoundedString(
    value.counterpartId,
    "$.execution.counterpartId",
    128,
  );
  const resourceType =
    value.resourceType === null
      ? null
      : (validateBoundedString(
          value.resourceType,
          "$.execution.resourceType",
          1,
          64,
        ) as ResourceConstant);
  const resourceRequired = value.version === 3 || action === "transfer" || action === "withdraw";
  if (resourceRequired !== (resourceType !== null)) {
    invalid(
      "execution-resource-mismatch",
      "$.execution.resourceType",
      resourceRequired ? "is required for this action" : "must be null for this action",
    );
  }
  if (value.version === 2) {
    if (action !== "harvest" || resourceType !== null) {
      invalid("execution-v2-action-mismatch", "$.execution.action", "v2 is harvest-only");
    }
    return {
      action: "harvest",
      completion,
      counterpartId,
      resourceType: null,
      version: 2,
      workPosition: normalizePosition(
        value.workPosition as PositionSnapshot,
        "$.execution.workPosition",
      ),
    };
  }
  if (value.version === 3) {
    if (
      kind !== "haul" ||
      (action !== "pickup" && action !== "withdraw" && action !== "transfer")
    ) {
      invalid("execution-v3-action-mismatch", "$.execution.action", "v3 is haul-only");
    }
    const stage = value.stage;
    if (stage !== "acquire" && stage !== "deliver") {
      invalid("invalid-execution-stage", "$.execution.stage", "must be acquire or deliver");
    }
    if ((stage === "acquire") !== (action === "pickup" || action === "withdraw")) {
      invalid("execution-stage-action-mismatch", "$.execution.action", "must match the haul stage");
    }
    if (resourceType === null || counterpartId === null) {
      invalid(
        "execution-v3-endpoint-mismatch",
        "$.execution",
        "requires resource and counterpart ids",
      );
    }
    const recommendedCarry = integerInRange(
      value.recommendedCarry,
      "$.execution.recommendedCarry",
      0,
      25,
    );
    const recommendedMove = integerInRange(
      value.recommendedMove,
      "$.execution.recommendedMove",
      0,
      25,
    );
    if (recommendedCarry + recommendedMove > 50) {
      invalid("execution-v3-capability-too-large", "$.execution", "may recommend at most 50 parts");
    }
    return {
      action,
      completion,
      counterpartId,
      flowId: validateBoundedString(value.flowId, "$.execution.flowId", 1, 128),
      recommendedCarry,
      recommendedMove,
      reservedAmount: positiveInteger(value.reservedAmount, "$.execution.reservedAmount"),
      resourceType,
      stage,
      version: 3,
    };
  }
  return {
    action,
    completion,
    completionHits,
    counterpartId,
    resourceType,
    version: 1,
  };
}

function actionMatchesContractKind(
  action: ContractExecutionAction,
  kind: WorkContractKind,
): boolean {
  switch (kind) {
    case "harvest":
      return action === "harvest";
    case "fill":
      return action === "transfer";
    case "haul":
      return action === "pickup" || action === "transfer" || action === "withdraw";
    case "repair":
      return action === "repair";
    case "build":
      return action === "build";
    case "upgrade":
      return action === "upgrade-controller";
    case "defend":
    case "scout":
    case "other":
      return false;
  }
}

function normalizeStringSet(value: unknown, path: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid("invalid-string-set", path, `must contain at most ${String(maximum)} items`);
  }
  const normalized = value.map((item, index) =>
    validateBoundedString(item, `${path}[${String(index)}]`, 1, 128),
  );
  const unique = [...new Set(normalized)].sort(compareStrings);
  if (unique.length !== normalized.length) {
    invalid("duplicate-string", path, "must not contain duplicate values");
  }
  return Object.freeze(unique);
}

function nullableBoundedString(value: unknown, path: string, maximum: number): string | null {
  return value === null ? null : validateBoundedString(value, path, 1, maximum);
}

function validateBoundedString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    invalid(
      "invalid-string",
      path,
      `must be trimmed and contain ${String(minimum)}-${String(maximum)} code units`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  return integerInRange(value, path, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value: unknown, path: string): number {
  return integerInRange(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function integerInRange(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(
      "invalid-integer",
      path,
      `must be a safe integer in [${String(minimum)}, ${String(maximum)}]`,
    );
  }
  return value as number;
}

function invalid(code: string, path: string, message: string): never {
  throw new ContractValidationError(code, path, message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
