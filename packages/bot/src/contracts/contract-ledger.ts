import type { MemoryManager, MemoryStageResult } from "../state/memory";
import {
  MAX_ACTIVE_CONTRACTS,
  MAX_CONTRACT_HISTORY,
  MAX_CONTRACT_FUNDING_AUTHORIZATIONS,
  MAX_CONTRACT_ISSUERS,
  MAX_CONTRACT_OUTCOMES,
  MAX_CONTRACT_REQUESTS_PER_TICK,
  MAX_CONTRACT_TRANSITIONS_PER_TICK,
  ContractValidationError,
  CONTRACT_FUNDING_AUTHORIZATION_STATUSES,
  capabilitySatisfies,
  compareStrings,
  contractFundingBindingKey,
  contractIdFor,
  normalizeContractRequest,
  requestSignature,
  type ActiveWorkContractState,
  type ContractHistoryEvent,
  type ContractFundingAuthorization,
  type ContractFundingDecision,
  type ContractFundingDecisionReason,
  type ContractFundingView,
  type ContractPlanningView,
  type ContractIssuerFrontier,
  type ContractExecutionView,
  type ContractLedgerStateV1,
  type LeasedWorkExecution,
  type ContractOutcome,
  type ContractTransitionRequest,
  type TerminalWorkContractState,
  type WorkforceActor,
  type WorkContractRecord,
  type WorkContractRequest,
  type WorkContractState,
} from "./contracts";
import {
  isLegalContractTransition,
  openContractLedgerState,
  serializeContractLedgerState,
} from "./schema";
import {
  WorkforceAllocator,
  remainingModeledTicks,
  type ContractAssignmentProposal,
  type TravelEstimateView,
  type WorkforceAllocationResult,
} from "./workforce-allocator";

export type ContractLedgerOpenResult =
  | { readonly ledger: ContractLedger; readonly status: "ready" }
  | { readonly error: ContractValidationError; readonly status: "invalid" }
  | { readonly foundSchemaVersion: number; readonly status: "unsupported" };

export type ContractSubmissionResult =
  | {
      readonly contractId: string;
      readonly outcome: "created" | "duplicate-active" | "duplicate-terminal";
      readonly accepted: true;
    }
  | {
      readonly contractId: string | null;
      readonly reason:
        | "capacity"
        | "funding-binding-conflict"
        | "idempotency-conflict"
        | "invalid-request"
        | "issuer-capacity"
        | "issuer-sequence-conflict"
        | "issuer-sequence-regressed"
        | "request-limit"
        | "retired-identity";
      readonly accepted: false;
    };

export type ContractTransitionResult =
  | {
      readonly accepted: true;
      readonly contractId: string;
      readonly from: ActiveWorkContractState;
      readonly to: WorkContractState;
    }
  | {
      readonly accepted: false;
      readonly contractId: string;
      readonly reason:
        | "assignment-required"
        | "contract-not-found"
        | "funding-authorization-required"
        | "funding-authorization-unavailable"
        | "funding-owner-not-colony"
        | "funding-owner-observation-unknown"
        | "funding-reservation-expired"
        | "funding-reservation-inactive"
        | "funding-reservation-missing"
        | "illegal-transition"
        | "invalid-transition"
        | "transition-limit";
    };

export interface LeaseReleaseRecord {
  readonly contractId: string;
  readonly reason: LeaseReleaseReason;
}

export type LeaseReleaseReason =
  | "actor-capability-lost"
  | "actor-missing"
  | "actor-name-mismatch"
  | "actor-spawning"
  | "actor-ttl-insufficient"
  | "allocator-unassigned"
  | "budget-authorization-lost"
  | "deadline-infeasible"
  | "lease-expired"
  | "travel-unknown";

export interface ContractReconciliationResult {
  readonly allocation: WorkforceAllocationResult;
  readonly funding: readonly ContractFundingDecision[];
  readonly releases: readonly LeaseReleaseRecord[];
  readonly submissions: readonly ContractSubmissionResult[];
  readonly transitions: readonly ContractTransitionResult[];
}

/** Sole state-machine and persistence authority for the `contracts` owner subtree. */
export class ContractLedger {
  readonly #allocator: WorkforceAllocator;
  #active: WorkContractRecord[];
  #changed: boolean;
  #issuerFrontiers: ContractIssuerFrontier[];
  #outcomes: ContractOutcome[];
  #quotaTick: number | null = null;
  #requestCount = 0;
  #transitionCount = 0;

  private constructor(
    state: ContractLedgerStateV1,
    initialized: boolean,
    allocator = new WorkforceAllocator(),
  ) {
    this.#active = [...state.active];
    this.#issuerFrontiers = [...state.issuerFrontiers];
    this.#outcomes = [...state.outcomes];
    this.#changed = initialized;
    this.#allocator = allocator;
  }

  public static open(value: unknown): ContractLedgerOpenResult {
    const opened = openContractLedgerState(value);
    if (opened.status === "invalid") {
      return opened;
    }
    if (opened.status === "unsupported") {
      return opened;
    }
    return {
      ledger: new ContractLedger(opened.state, opened.initialized),
      status: "ready",
    };
  }

  public get changed(): boolean {
    return this.#changed;
  }

  public view(): ContractLedgerStateV1 {
    return snapshotState(this.#active, this.#issuerFrontiers, this.#outcomes);
  }

  /**
   * Returns the sole sanitized leased-work projection for plan systems. Contracts without explicit
   * execution terms are legacy data and deliberately fail closed by not appearing in this view.
   */
  public executionView(): ContractExecutionView {
    const leases: LeasedWorkExecution[] = [];
    for (const record of this.#active) {
      if (record.lease === null || record.execution === undefined || record.targetId === null) {
        continue;
      }
      leases.push({
        actorId: record.lease.actorId,
        actorName: record.lease.actorName,
        contractId: record.id,
        deadline: record.deadline,
        execution: { ...record.execution },
        expiresAt: record.expiresAt,
        leaseExpiresAt: record.lease.expiresAt,
        priority: { ...record.priority },
        quantity: record.quantity,
        range: record.range,
        revision: record.revision,
        state: record.state === "assigned" ? "assigned" : "active",
        target: { ...record.target },
        targetId: record.targetId,
      });
    }
    leases.sort(
      (left, right) =>
        compareStrings(left.actorId, right.actorId) ||
        compareStrings(left.contractId, right.contractId),
    );
    return deepFreeze({ leases, status: "ready" });
  }

  /** Sanitized active records for bounded planners; no owner-state bytes or lease history escape. */
  public planningView(): ContractPlanningView {
    const contracts = this.#active
      .flatMap((record) => {
        if (record.execution === undefined || record.targetId === null) return [];
        return [
          {
            budgetBinding: { ...record.budgetBinding },
            contractId: record.id,
            execution: { ...record.execution },
            issuer: record.issuer,
            owner: { ...record.owner },
            state: record.state,
            targetId: record.targetId,
          },
        ];
      })
      .sort((left, right) => compareStrings(left.contractId, right.contractId));
    return deepFreeze({ contracts, status: "ready" });
  }

  public submit(request: WorkContractRequest, tick: number): ContractSubmissionResult {
    let normalized: WorkContractRequest;
    try {
      validateTick(tick);
      if (!this.prepareQuotaTick(tick)) {
        return { accepted: false, contractId: null, reason: "invalid-request" };
      }
      if (this.#requestCount >= MAX_CONTRACT_REQUESTS_PER_TICK) {
        return { accepted: false, contractId: null, reason: "request-limit" };
      }
      this.#requestCount += 1;
      normalized = normalizeContractRequest(request);
    } catch (error: unknown) {
      if (
        error instanceof ContractValidationError ||
        error instanceof RangeError ||
        error instanceof TypeError
      ) {
        return { accepted: false, contractId: null, reason: "invalid-request" };
      }
      throw error;
    }

    const id = contractIdFor(normalized.issuer, normalized.issuerKey, normalized.issuerSequence);
    const signature = requestSignature(normalized);
    const active = this.#active.find((record) => record.id === id);
    if (active !== undefined) {
      return active.requestSignature === signature
        ? { accepted: true, contractId: id, outcome: "duplicate-active" }
        : { accepted: false, contractId: id, reason: "idempotency-conflict" };
    }
    const terminal = this.#outcomes.find((outcome) => outcome.id === id);
    if (terminal !== undefined) {
      return terminal.requestSignature === signature
        ? { accepted: true, contractId: id, outcome: "duplicate-terminal" }
        : { accepted: false, contractId: id, reason: "idempotency-conflict" };
    }
    if (
      this.#active.some(
        (record) =>
          record.issuer === normalized.issuer &&
          record.issuerSequence === normalized.issuerSequence,
      )
    ) {
      return { accepted: false, contractId: id, reason: "issuer-sequence-conflict" };
    }
    const retiredThrough = this.#issuerFrontiers.find(
      ({ issuer }) => issuer === normalized.issuer,
    )?.retiredThrough;
    if (retiredThrough !== undefined && normalized.issuerSequence <= retiredThrough) {
      return { accepted: false, contractId: id, reason: "retired-identity" };
    }
    const greatestActiveSequence = this.#active.reduce(
      (greatest, record) =>
        record.issuer === normalized.issuer ? Math.max(greatest, record.issuerSequence) : greatest,
      -1,
    );
    if (normalized.issuerSequence < greatestActiveSequence) {
      return { accepted: false, contractId: id, reason: "issuer-sequence-regressed" };
    }
    const knownIssuers = new Set([
      ...this.#issuerFrontiers.map(({ issuer }) => issuer),
      ...this.#active.map(({ issuer }) => issuer),
    ]);
    if (!knownIssuers.has(normalized.issuer) && knownIssuers.size >= MAX_CONTRACT_ISSUERS) {
      return { accepted: false, contractId: id, reason: "issuer-capacity" };
    }
    const bindingKey = contractFundingBindingKey(normalized);
    if (this.#active.some((record) => contractFundingBindingKey(record) === bindingKey)) {
      return { accepted: false, contractId: id, reason: "funding-binding-conflict" };
    }
    if (this.#active.length >= MAX_ACTIVE_CONTRACTS) {
      return { accepted: false, contractId: id, reason: "capacity" };
    }

    const record: WorkContractRecord = deepFreeze({
      ...normalized,
      history: [
        {
          from: null,
          reason: "issuer-requested",
          tick,
          to: "proposed" as const,
        },
      ],
      id,
      lease: null,
      requestSignature: signature,
      revision: 1,
      state: "proposed" as const,
    });
    this.#active.push(record);
    this.#active.sort((left, right) => compareStrings(left.id, right.id));
    this.#changed = true;
    return { accepted: true, contractId: id, outcome: "created" };
  }

  public transition(request: ContractTransitionRequest): ContractTransitionResult {
    return this.transitionWithFunding(request, null);
  }

  private transitionWithFunding(
    request: ContractTransitionRequest,
    funding: ContractFundingView | null,
  ): ContractTransitionResult {
    if (!validTransitionRequest(request)) {
      return { accepted: false, contractId: request.contractId, reason: "invalid-transition" };
    }
    if (!this.prepareQuotaTick(request.tick)) {
      return { accepted: false, contractId: request.contractId, reason: "invalid-transition" };
    }
    if (this.#transitionCount >= MAX_CONTRACT_TRANSITIONS_PER_TICK) {
      return { accepted: false, contractId: request.contractId, reason: "transition-limit" };
    }
    this.#transitionCount += 1;
    const index = this.#active.findIndex((record) => record.id === request.contractId);
    const record = this.#active[index];
    if (index < 0 || record === undefined) {
      return { accepted: false, contractId: request.contractId, reason: "contract-not-found" };
    }
    if (!isLegalContractTransition(record.state, request.to)) {
      return { accepted: false, contractId: record.id, reason: "illegal-transition" };
    }
    const latest = record.history[record.history.length - 1];
    if (latest !== undefined && request.tick < latest.tick) {
      return { accepted: false, contractId: record.id, reason: "invalid-transition" };
    }
    if (request.tick >= record.expiresAt) {
      return { accepted: false, contractId: record.id, reason: "invalid-transition" };
    }
    if (request.to === "assigned") {
      return { accepted: false, contractId: record.id, reason: "assignment-required" };
    }
    if (request.to === "funded") {
      if (funding === null) {
        return {
          accepted: false,
          contractId: record.id,
          reason: "funding-authorization-required",
        };
      }
      const authorization = resolveFunding(record, funding, request.tick);
      if (authorization.status !== "authorized") {
        if (authorization.reason === "authorized") {
          throw new Error("Contract funding decision invariant failed");
        }
        return {
          accepted: false,
          contractId: record.id,
          reason: transitionFundingReason(authorization.reason),
        };
      }
    }

    this.applyTransition(index, request.to, request.tick, request.reason);
    return { accepted: true, contractId: record.id, from: record.state, to: request.to };
  }

  public reconcile(input: {
    readonly actors: readonly WorkforceActor[];
    readonly funding: ContractFundingView;
    readonly requests: readonly WorkContractRequest[];
    readonly tick: number;
    readonly transitions: readonly ContractTransitionRequest[];
    readonly travel: TravelEstimateView;
  }): ContractReconciliationResult {
    validateTick(input.tick);
    if (!this.prepareQuotaTick(input.tick)) {
      throw new RangeError("Contract reconciliation tick must not move backwards");
    }
    const fundingView = normalizeFundingView(input.funding);
    if (input.requests.length > MAX_CONTRACT_REQUESTS_PER_TICK) {
      throw new RangeError("Contract reconciliation request batch exceeds its hard limit");
    }
    if (input.transitions.length > MAX_CONTRACT_TRANSITIONS_PER_TICK) {
      throw new RangeError("Contract reconciliation transition batch exceeds its hard limit");
    }
    const submissions = [...input.requests]
      .sort(compareSubmissionRequests)
      .map((request) => this.submit(request, input.tick));

    for (const record of [...this.#active]) {
      if (input.tick >= record.expiresAt) {
        this.transitionSystem(record.id, "expired", input.tick, "contract-expired");
      }
    }
    const transitions = [...input.transitions]
      .sort(compareTransitionRequests)
      .map((request) => this.transitionForTick(request, input.tick, fundingView));

    const actorsById = new Map(input.actors.map((actor) => [actor.id, actor]));
    const releases: LeaseReleaseRecord[] = [];
    const funding: ContractFundingDecision[] = [];
    const quarantinedContractIds = new Set<string>();
    const quarantinedActorIds = new Set<string>();

    for (const record of [...this.#active]) {
      const decision = resolveFunding(record, fundingView, input.tick);
      funding.push(decision);
      if (decision.status === "unavailable") {
        quarantinedContractIds.add(record.id);
        if (record.lease !== null) {
          quarantinedActorIds.add(record.lease.actorId);
        }
        continue;
      }
      if (decision.status === "authorized") {
        continue;
      }
      if (record.state === "funded") {
        this.transitionSystem(record.id, "suspended", input.tick, `budget-${decision.reason}`);
      } else if (
        (record.state === "assigned" || record.state === "active") &&
        this.releaseLease(record.id, input.tick, "budget-authorization-lost", false)
      ) {
        releases.push({ contractId: record.id, reason: "budget-authorization-lost" });
      }
    }

    for (const record of [...this.#active]) {
      if (record.lease === null || quarantinedContractIds.has(record.id)) {
        continue;
      }
      const reason = invalidLeaseReason(record, actorsById.get(record.lease.actorId), input);
      if (reason !== null && this.releaseLease(record.id, input.tick, reason, true)) {
        releases.push({ contractId: record.id, reason });
      }
    }

    const allocation = this.#allocator.allocate({
      actors: input.actors.filter((actor) => !quarantinedActorIds.has(actor.id)),
      contracts: this.#active.filter((record) => !quarantinedContractIds.has(record.id)),
      tick: input.tick,
      travel: input.travel,
    });
    const proposalByContract = new Map(
      allocation.assignments.map((proposal) => [proposal.contractId, proposal]),
    );
    const preserved = new Set(allocation.preservedContractIds);

    for (const record of [...this.#active]) {
      if (quarantinedContractIds.has(record.id)) {
        continue;
      }
      const proposal = proposalByContract.get(record.id);
      if (record.lease !== null) {
        if (preserved.has(record.id)) {
          continue;
        }
        if (proposal?.actorId === record.lease.actorId) {
          continue;
        }
        if (this.releaseLease(record.id, input.tick, "allocator-unassigned", true)) {
          releases.push({ contractId: record.id, reason: "allocator-unassigned" });
        }
      }

      if (
        proposal !== undefined &&
        resolveFunding(record, fundingView, input.tick).status === "authorized"
      ) {
        this.assignLease(record.id, proposal, input.tick);
      }
    }

    return deepFreeze({ allocation, funding, releases, submissions, transitions });
  }

  /** Stages this authority's complete validated draft; only MemoryManager commits the root. */
  public stage(manager: MemoryManager): MemoryStageResult {
    const serialized = serializeContractLedgerState(this.view());
    const transaction = manager.transaction("contracts");
    transaction.replace(serialized);
    return transaction.stage();
  }

  private applyTransition(
    index: number,
    to: WorkContractState,
    tick: number,
    reason: string,
  ): void {
    const record = this.#active[index];
    if (record === undefined) {
      throw new Error("Contract transition index disappeared");
    }
    const event = transitionEvent(record.state, to, tick, reason);
    const revision = record.revision + 1;

    if (isTerminalState(to)) {
      this.#active.splice(index, 1);
      this.retireIssuer(record.issuer, record.issuerSequence);
      this.#outcomes.push(
        deepFreeze({
          id: record.id,
          issuer: record.issuer,
          issuerKey: record.issuerKey,
          issuerSequence: record.issuerSequence,
          reason,
          requestSignature: record.requestSignature,
          revision,
          state: to,
          tick,
        }),
      );
      this.#outcomes.sort(
        (left, right) => left.tick - right.tick || compareStrings(left.id, right.id),
      );
      if (this.#outcomes.length > MAX_CONTRACT_OUTCOMES) {
        this.#outcomes = this.#outcomes.slice(-MAX_CONTRACT_OUTCOMES);
      }
    } else {
      this.#active[index] = deepFreeze({
        ...record,
        history: appendHistory(record.history, event),
        lease: to === "assigned" || to === "active" ? record.lease : null,
        revision,
        state: to,
      });
    }
    this.#changed = true;
  }

  private transitionForTick(
    request: ContractTransitionRequest,
    tick: number,
    funding: ContractFundingView,
  ): ContractTransitionResult {
    if (request.tick === tick) {
      return this.transitionWithFunding(request, funding);
    }
    if (this.#transitionCount >= MAX_CONTRACT_TRANSITIONS_PER_TICK) {
      return { accepted: false, contractId: request.contractId, reason: "transition-limit" };
    }
    this.#transitionCount += 1;
    return { accepted: false, contractId: request.contractId, reason: "invalid-transition" };
  }

  /** Mandatory lifecycle work is bounded by the active cap and cannot be starved by producer quota. */
  private transitionSystem(
    contractId: string,
    to: WorkContractState,
    tick: number,
    reason: string,
  ): void {
    const index = this.#active.findIndex((record) => record.id === contractId);
    const record = this.#active[index];
    if (record === undefined || !isLegalContractTransition(record.state, to)) {
      throw new Error("ContractLedger attempted an illegal system transition");
    }
    this.applyTransition(index, to, tick, reason);
  }

  private assignLease(
    contractId: string,
    proposal: ContractAssignmentProposal,
    tick: number,
  ): void {
    const index = this.#active.findIndex((record) => record.id === contractId);
    const record = this.#active[index];
    if (record === undefined || record.state !== "funded") {
      return;
    }
    const event = transitionEvent(record.state, "assigned", tick, "workforce-assigned");
    this.#active[index] = deepFreeze({
      ...record,
      history: appendHistory(record.history, event),
      lease: {
        actorId: proposal.actorId,
        actorName: proposal.actorName,
        assignedAt: tick,
        assignmentCost: proposal.assignmentCost,
        expiresAt: proposal.leaseExpiresAt,
        travelTicks: proposal.travelTicks,
      },
      revision: record.revision + 1,
      state: "assigned",
    });
    this.#changed = true;
  }

  private releaseLease(
    contractId: string,
    tick: number,
    reason: LeaseReleaseReason,
    retainFunding: boolean,
  ): boolean {
    let index = this.#active.findIndex((record) => record.id === contractId);
    const record = this.#active[index];
    if (record === undefined || (record.state !== "assigned" && record.state !== "active")) {
      return false;
    }
    this.applyTransition(index, "suspended", tick, reason);
    if (retainFunding) {
      index = this.#active.findIndex((candidate) => candidate.id === contractId);
      this.applyTransition(index, "funded", tick, "work-remains-funded");
    }
    return true;
  }

  private prepareQuotaTick(tick: number): boolean {
    if (this.#quotaTick !== null && tick < this.#quotaTick) {
      return false;
    }
    if (this.#quotaTick === null || tick > this.#quotaTick) {
      this.#quotaTick = tick;
      this.#requestCount = 0;
      this.#transitionCount = 0;
    }
    return true;
  }

  private retireIssuer(issuer: string, sequence: number): void {
    const index = this.#issuerFrontiers.findIndex((frontier) => frontier.issuer === issuer);
    const current = this.#issuerFrontiers[index];
    if (current !== undefined) {
      if (sequence > current.retiredThrough) {
        this.#issuerFrontiers[index] = deepFreeze({ issuer, retiredThrough: sequence });
      }
      return;
    }
    if (this.#issuerFrontiers.length >= MAX_CONTRACT_ISSUERS) {
      throw new Error("ContractLedger issuer frontier capacity invariant failed");
    }
    this.#issuerFrontiers.push(deepFreeze({ issuer, retiredThrough: sequence }));
    this.#issuerFrontiers.sort((left, right) => compareStrings(left.issuer, right.issuer));
  }
}

function normalizeFundingView(value: ContractFundingView): ContractFundingView {
  const candidate: unknown = value;
  if (!isRecord(candidate)) {
    fundingInvalid("invalid-funding-view", "$.funding", "must be a data object");
  }
  if (candidate.status === "unavailable") {
    if (
      !hasExactKeys(candidate, ["reason", "status"]) ||
      !isFundingUnavailableReason(candidate.reason)
    ) {
      fundingInvalid(
        "invalid-funding-view",
        "$.funding",
        "unavailable view must contain one bounded reason",
      );
    }
    return deepFreeze({ reason: candidate.reason, status: "unavailable" });
  }
  if (
    candidate.status !== "ready" ||
    !hasExactKeys(candidate, ["authorizations", "owners", "status"]) ||
    !isUnknownArray(candidate.authorizations) ||
    !isUnknownArray(candidate.owners) ||
    candidate.authorizations.length > MAX_CONTRACT_FUNDING_AUTHORIZATIONS ||
    candidate.owners.length > 64
  ) {
    fundingInvalid(
      "invalid-funding-view",
      "$.funding",
      "ready view exceeds its shape or cardinality bounds",
    );
  }

  const owners = candidate.owners.map((owner, index) => {
    const path = `$.funding.owners[${String(index)}]`;
    if (
      !isRecord(owner) ||
      !hasExactKeys(owner, ["id", "visibility"]) ||
      !validFundingString(owner.id, 128) ||
      (owner.visibility !== "unknown" && owner.visibility !== "visible")
    ) {
      fundingInvalid("invalid-funding-owner", path, "must identify one bounded colony view");
    }
    return {
      id: owner.id,
      visibility: owner.visibility === "unknown" ? ("unknown" as const) : ("visible" as const),
    };
  });
  owners.sort((left, right) => compareStrings(left.id, right.id));
  requireUniqueFundingKeys(
    owners.map(({ id }) => id),
    "$.funding.owners",
  );

  const authorizations = candidate.authorizations.map((authorization, index) =>
    normalizeFundingAuthorization(authorization, index),
  );
  authorizations.sort((left, right) =>
    compareStrings(
      fundingKey(left.colonyId, left.category, left.issuer),
      fundingKey(right.colonyId, right.category, right.issuer),
    ),
  );
  requireUniqueFundingKeys(
    authorizations.map(({ category, colonyId, issuer }) => fundingKey(colonyId, category, issuer)),
    "$.funding.authorizations",
  );
  const ownerIds = new Set(owners.map(({ id }) => id));
  if (authorizations.some(({ colonyId }) => !ownerIds.has(colonyId))) {
    fundingInvalid(
      "invalid-funding-authorization",
      "$.funding.authorizations",
      "authorization references a colony outside the owner view",
    );
  }

  return deepFreeze({ authorizations, owners, status: "ready" });
}

function normalizeFundingAuthorization(
  value: unknown,
  index: number,
): ContractFundingAuthorization {
  const path = `$.funding.authorizations[${String(index)}]`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "category",
      "colonyId",
      "expiresAt",
      "issuer",
      "reservationId",
      "revision",
      "status",
    ]) ||
    !validFundingString(value.category, 64) ||
    !validFundingString(value.colonyId, 128) ||
    !validFundingString(value.issuer, 128) ||
    !validFundingString(value.reservationId, 384) ||
    !isNonNegativeSafeInteger(value.expiresAt) ||
    !isNonNegativeSafeInteger(value.revision) ||
    !isFundingAuthorizationStatus(value.status)
  ) {
    fundingInvalid(
      "invalid-funding-authorization",
      path,
      "must contain one bounded current BudgetLedger entry",
    );
  }
  return {
    category: value.category,
    colonyId: value.colonyId,
    expiresAt: value.expiresAt,
    issuer: value.issuer,
    reservationId: value.reservationId,
    revision: value.revision,
    status: value.status,
  };
}

function resolveFunding(
  contract: WorkContractRecord,
  view: ContractFundingView,
  tick: number,
): ContractFundingDecision {
  if (view.status === "unavailable") {
    return {
      contractId: contract.id,
      reason: "authorization-unavailable",
      reservationId: null,
      status: "unavailable",
    };
  }
  if (contract.owner.kind !== "colony") {
    return deniedFunding(contract.id, "owner-not-colony");
  }
  const owner = view.owners.find(({ id }) => id === contract.owner.id);
  if (owner === undefined || owner.visibility === "unknown") {
    return {
      contractId: contract.id,
      reason: "owner-observation-unknown",
      reservationId: null,
      status: "unavailable",
    };
  }
  const authorization = view.authorizations.find(
    ({ category, colonyId, issuer }) =>
      colonyId === contract.owner.id &&
      category === contract.budgetBinding.category &&
      issuer === contract.budgetBinding.issuer,
  );
  if (authorization === undefined) {
    return deniedFunding(contract.id, "reservation-missing");
  }
  if (authorization.status === "expired" || authorization.expiresAt < tick) {
    return deniedFunding(contract.id, "reservation-expired", authorization.reservationId);
  }
  if (authorization.status !== "active") {
    return deniedFunding(contract.id, "reservation-inactive", authorization.reservationId);
  }
  return {
    contractId: contract.id,
    reason: "authorized",
    reservationId: authorization.reservationId,
    status: "authorized",
  };
}

function deniedFunding(
  contractId: string,
  reason: Exclude<
    ContractFundingDecisionReason,
    "authorized" | "authorization-unavailable" | "owner-observation-unknown"
  >,
  reservationId: string | null = null,
): ContractFundingDecision {
  return { contractId, reason, reservationId, status: "denied" };
}

function transitionFundingReason(
  reason: Exclude<ContractFundingDecisionReason, "authorized">,
):
  | "funding-authorization-unavailable"
  | "funding-owner-not-colony"
  | "funding-owner-observation-unknown"
  | "funding-reservation-expired"
  | "funding-reservation-inactive"
  | "funding-reservation-missing" {
  switch (reason) {
    case "authorization-unavailable":
      return "funding-authorization-unavailable";
    case "owner-not-colony":
      return "funding-owner-not-colony";
    case "owner-observation-unknown":
      return "funding-owner-observation-unknown";
    case "reservation-expired":
      return "funding-reservation-expired";
    case "reservation-inactive":
      return "funding-reservation-inactive";
    case "reservation-missing":
      return "funding-reservation-missing";
  }
}

function fundingKey(colonyId: string, category: string, issuer: string): string {
  return `${colonyId}\u0000${category}\u0000${issuer}`;
}

function requireUniqueFundingKeys(keys: readonly string[], path: string): void {
  if (new Set(keys).size !== keys.length) {
    fundingInvalid("duplicate-funding-key", path, "must not contain duplicate identities");
  }
}

function validFundingString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}

function isFundingAuthorizationStatus(
  value: unknown,
): value is ContractFundingAuthorization["status"] {
  return CONTRACT_FUNDING_AUTHORIZATION_STATUSES.some((status) => status === value);
}

function isFundingUnavailableReason(
  value: unknown,
): value is Extract<ContractFundingView, { readonly status: "unavailable" }>["reason"] {
  return (
    value === "colony-owner-future-schema" ||
    value === "colony-owner-malformed" ||
    value === "colony-owner-unavailable" ||
    value === "colony-planning-not-run"
  );
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fundingInvalid(code: string, path: string, message: string): never {
  throw new ContractValidationError(code, path, message);
}

function invalidLeaseReason(
  contract: WorkContractRecord,
  actor: WorkforceActor | undefined,
  input: {
    readonly tick: number;
    readonly travel: TravelEstimateView;
  },
): LeaseReleaseReason | null {
  const lease = contract.lease;
  if (lease === null) {
    return null;
  }
  if (input.tick >= lease.expiresAt) {
    return "lease-expired";
  }
  if (actor === undefined) {
    return "actor-missing";
  }
  if (actor.name !== lease.actorName) {
    return "actor-name-mismatch";
  }
  if (actor.spawning) {
    return "actor-spawning";
  }
  if (!capabilitySatisfies(actor.capability, contract.requiredCapability)) {
    return "actor-capability-lost";
  }
  if (actor.ticksToLive === null) {
    return "actor-ttl-insufficient";
  }
  const travel = input.travel.estimate(actor, contract);
  if (!Number.isSafeInteger(travel) || (travel ?? -1) < 0) {
    return "travel-unknown";
  }
  const remaining = remainingModeledTicks(contract, input.tick, travel as number);
  if (input.tick + remaining > contract.deadline) {
    return "deadline-infeasible";
  }
  // Reconcile follows this tick's Execute phase. Only TTL after the current tick is available for
  // the remaining modeled schedule.
  if (actor.ticksToLive - 1 - remaining < contract.leasePolicy.ttlSafetyMargin) {
    return "actor-ttl-insufficient";
  }
  return null;
}

function snapshotState(
  active: readonly WorkContractRecord[],
  issuerFrontiers: readonly ContractIssuerFrontier[],
  outcomes: readonly ContractOutcome[],
): ContractLedgerStateV1 {
  return deepFreeze({
    active: [...active],
    issuerFrontiers: [...issuerFrontiers],
    outcomes: [...outcomes],
    schemaVersion: 1 as const,
  });
}

function compareSubmissionRequests(left: WorkContractRequest, right: WorkContractRequest): number {
  return (
    compareStrings(left.issuer, right.issuer) ||
    left.issuerSequence - right.issuerSequence ||
    compareStrings(left.issuerKey, right.issuerKey) ||
    compareStrings(requestSignature(left), requestSignature(right))
  );
}

function compareTransitionRequests(
  left: ContractTransitionRequest,
  right: ContractTransitionRequest,
): number {
  return (
    left.tick - right.tick ||
    compareStrings(left.contractId, right.contractId) ||
    compareStrings(left.to, right.to) ||
    compareStrings(left.reason, right.reason)
  );
}

function appendHistory(
  history: readonly ContractHistoryEvent[],
  event: ContractHistoryEvent,
): readonly ContractHistoryEvent[] {
  return [...history, event].slice(-MAX_CONTRACT_HISTORY);
}

function transitionEvent(
  from: ActiveWorkContractState,
  to: WorkContractState,
  tick: number,
  reason: string,
): ContractHistoryEvent {
  return { from, reason, tick, to };
}

function validTransitionRequest(request: ContractTransitionRequest): boolean {
  return (
    typeof request.contractId === "string" &&
    request.contractId.length > 0 &&
    request.contractId.length <= 512 &&
    typeof request.reason === "string" &&
    request.reason.length > 0 &&
    request.reason.length <= 128 &&
    request.reason === request.reason.trim() &&
    Number.isSafeInteger(request.tick) &&
    request.tick >= 0
  );
}

function isTerminalState(state: WorkContractState): state is TerminalWorkContractState {
  return (
    state === "completed" || state === "cancelled" || state === "expired" || state === "failed"
  );
}

function validateTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError("Contract ledger tick must be a non-negative safe integer");
  }
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
