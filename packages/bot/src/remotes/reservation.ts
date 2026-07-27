import type { BudgetRequest } from "../colony";
import type {
  ContractPlanningRecord,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import {
  REMOTE_RESERVATION_LIMITS,
  type RemoteReservationBudgetEntry,
  type RemoteReservationDisposition,
  type RemoteReservationMetrics,
  type RemoteReservationObjectiveEvidence,
  type RemoteReservationPlan,
  type RemoteReservationPlanInput,
  type RemoteReservationPolicyV1,
  type RemoteReservationReason,
} from "./reservation-contracts";

const ISSUER_PREFIX = "remote-reservation/";

interface Evaluation {
  readonly item: RemoteReservationObjectiveEvidence;
  readonly currentReservationTicks: number;
  readonly leadTicks: number;
  readonly reason: RemoteReservationReason | null;
  readonly routeTravelTicks: number;
}

/**
 * Pure bridge from one funded portfolio objective into normal colony budgets and WorkContracts.
 * ContractLedger, WorkforceAllocator, SpawnBroker, MovementArbiter, and executors retain authority.
 */
export class RemoteReservationPlanner {
  public plan(input: RemoteReservationPlanInput): RemoteReservationPlan {
    if (!validInput(input)) return emptyPlan("invalid-input");
    if (input.contracts.status !== "ready") return emptyPlan("contracts-unavailable");
    if (
      input.objectives.length > REMOTE_RESERVATION_LIMITS.maximumObjectivesPerTick ||
      input.budgets.length > REMOTE_RESERVATION_LIMITS.maximumBudgetEntries ||
      input.contracts.contracts.length > REMOTE_RESERVATION_LIMITS.maximumContractRecords
    )
      return emptyPlan("limit-exceeded");

    const objectives = [...input.objectives].sort(compareObjective);
    if (new Set(objectives.map(({ objective }) => objective.roomName)).size !== objectives.length)
      return emptyPlan("invalid-input");
    const existingByIssuer = new Map<string, ContractPlanningRecord>();
    for (const contract of input.contracts.contracts) {
      if (!contract.issuer.startsWith(ISSUER_PREFIX)) continue;
      if (existingByIssuer.has(contract.issuer)) return emptyPlan("invalid-input");
      existingByIssuer.set(contract.issuer, contract);
    }

    const budgets: BudgetRequest[] = [];
    const requests: WorkContractRequest[] = [];
    const transitions: ContractTransitionRequest[] = [];
    const dispositions: RemoteReservationDisposition[] = [];
    const handledIssuers = new Set<string>();
    let due = 0;
    let retries = 0;

    for (const item of objectives) {
      const issuer = issuerFor(item);
      handledIssuers.add(issuer);
      const existing = existingByIssuer.get(issuer);
      const evaluation = evaluate(item, input.tick, input.policy);
      if (evaluation.reason !== null) {
        dispositions.push(disposition(item, evaluation.reason, evaluation));
        stopExisting(existing, "remote-reservation-evidence-unavailable", input.tick, transitions);
        continue;
      }

      if (evaluation.currentReservationTicks >= input.policy.reservationTargetTicks) {
        dispositions.push(disposition(item, "reservation-target-reached", evaluation));
        completeExisting(existing, input.tick, transitions);
        continue;
      }
      const reservationDue =
        existing !== undefined || evaluation.currentReservationTicks <= evaluation.leadTicks;
      if (!reservationDue) {
        dispositions.push(disposition(item, "reservation-healthy", evaluation));
        continue;
      }
      due += 1;

      const modeledWorkTicks = Math.ceil(
        (input.policy.reservationTargetTicks - evaluation.currentReservationTicks) /
          Math.max(1, input.policy.claimParts - 1),
      );
      const deadline = input.tick + evaluation.routeTravelTicks + modeledWorkTicks;
      if (
        deadline >= item.candidate.expiresAt ||
        deadline - input.tick + input.policy.replacementSafetyTicks >=
          input.policy.claimCreepLifetime
      ) {
        dispositions.push(disposition(item, "timeout", evaluation));
        stopExisting(existing, "remote-reservation-timeout", input.tick, transitions);
        continue;
      }

      const budget = budgetFor(
        issuer,
        item.objective.donorColonyId,
        deadline + input.policy.replacementSafetyTicks + 1,
        input.budgets,
        input.policy,
        existing !== undefined,
        input.tick,
      );
      budgets.push(budget);
      const authorization = activeAuthorization(budget, input.budgets, input.policy);
      if (authorization === null) {
        dispositions.push(
          disposition(
            item,
            hasActiveAuthorization(budget, input.budgets)
              ? "budget-insufficient"
              : "budget-unavailable",
            evaluation,
          ),
        );
        stopExisting(existing, "remote-reservation-budget-unavailable", input.tick, transitions);
        continue;
      }

      const sequence =
        existing === undefined
          ? authorization.revision
          : Math.max(authorization.revision, (existing.issuerSequence ?? 0) + 1);
      const request = contractFor(
        item,
        budget,
        sequence,
        modeledWorkTicks,
        evaluation.routeTravelTicks,
        input.tick,
        input.policy,
      );
      if (JSON.stringify(request).length > REMOTE_RESERVATION_LIMITS.maximumContractCodeUnits) {
        dispositions.push(disposition(item, "memory-budget", evaluation));
        stopExisting(existing, "remote-reservation-memory-budget", input.tick, transitions);
        continue;
      }

      if (existing === undefined) {
        requests.push(request);
        dispositions.push(disposition(item, "reservation-due", evaluation));
        continue;
      }
      if (!compatible(existing, request)) {
        completeExisting(existing, input.tick, transitions, "cancelled", "route-replaced");
        requests.push(request);
        dispositions.push(disposition(item, "reservation-due", evaluation));
        continue;
      }
      if (existing.state === "proposed") {
        transitions.push({
          contractId: existing.contractId,
          reason: "remote-reservation-work-remains",
          tick: input.tick,
          to: "funded",
        });
      } else if (existing.state === "suspended") {
        const retry = existing.reservationRetry ?? null;
        if (retry !== null) {
          retries += 1;
          if (retry.attempts >= input.policy.maximumCommandAttempts) {
            // Keep the exact contract durably suspended until normal expiry. A terminal outcome is
            // absent from ContractPlanningView and could otherwise reopen under the same grant.
            dispositions.push(disposition(item, "retry-exhausted", evaluation));
            continue;
          }
          const delay = Math.min(
            input.policy.retryMaximumDelayTicks,
            input.policy.retryInitialDelayTicks * 2 ** Math.max(0, retry.attempts - 1),
          );
          if (input.tick < retry.eligibleAt + delay) {
            dispositions.push(disposition(item, "retry-wait", evaluation));
            continue;
          }
          transitions.push({
            contractId: existing.contractId,
            reason: "remote-reservation-retry-due",
            tick: input.tick,
            to: "funded",
          });
        } else {
          transitions.push({
            contractId: existing.contractId,
            reason: "remote-reservation-work-remains",
            tick: input.tick,
            to: "funded",
          });
        }
      }
      dispositions.push(disposition(item, "contract-active", evaluation));
    }

    for (const [issuer, contract] of [...existingByIssuer].sort(([left], [right]) =>
      compare(left, right),
    )) {
      if (handledIssuers.has(issuer)) continue;
      const roomName = issuerRoomName(issuer);
      dispositions.push({
        roomName,
        reason: "portfolio-unavailable",
        currentReservationTicks: 0,
        leadTicks: 0,
      });
      stopExisting(contract, "remote-reservation-portfolio-unavailable", input.tick, transitions);
    }

    budgets.sort(compareBudget);
    requests.sort((left, right) => compare(left.issuer, right.issuer));
    transitions.sort((left, right) => compare(left.contractId, right.contractId));
    dispositions.sort((left, right) => compare(left.roomName, right.roomName));
    if (transitions.length > REMOTE_RESERVATION_LIMITS.maximumTransitionsPerTick)
      return emptyPlan("limit-exceeded");
    return freeze({
      status: "ready",
      budgetRequests: budgets,
      contractRequests: requests,
      transitions,
      dispositions,
      metrics: metrics(objectives.length, due, budgets, requests, transitions, retries),
    });
  }
}

function evaluate(
  item: RemoteReservationObjectiveEvidence,
  tick: number,
  policy: RemoteReservationPolicyV1,
): Evaluation {
  const { candidate, objective } = item;
  const route = candidate.route.plan;
  const base = (reason: RemoteReservationReason | null, current = 0, lead = 0, travel = 0) => ({
    item,
    currentReservationTicks: current,
    leadTicks: lead,
    reason,
    routeTravelTicks: travel,
  });
  if (
    objective.roomName !== candidate.roomName ||
    objective.donorColonyId !== candidate.donorColonyId ||
    candidate.expiresAt <= tick
  )
    return base("portfolio-unavailable");
  if (objective.state !== "active") return base("objective-not-active");
  if (
    objective.commitment.energy < bodyEnergy(policy) ||
    objective.commitment.spawnTicks < spawnTicks(policy) ||
    objective.commitment.cpuMilli < policy.cpuMilli ||
    objective.commitment.memoryCodeUnits <= 0
  )
    return base("portfolio-budget");
  if (candidate.intel.freshness === "stale" || candidate.intel.freshness === "expired")
    return base("intel-stale");
  if (candidate.intel.freshness === "unknown" || candidate.intel.record === null)
    return base("intel-unavailable");
  if (
    candidate.intel.record.observedAt > tick ||
    tick - candidate.intel.record.observedAt > policy.maximumIntelAgeTicks
  )
    return base("intel-stale");
  if (candidate.intel.quality !== "complete" || !candidate.intel.record.complete)
    return base("intel-partial");
  if (
    candidate.route.status !== "ready" ||
    route === null ||
    route.originRoomName !== objective.donorColonyId ||
    route.destinationRoomName !== objective.roomName ||
    route.roomNames.length < 1 ||
    route.roomNames.length > REMOTE_RESERVATION_LIMITS.maximumRouteRooms ||
    route.roomNames[route.roomNames.length - 1] !== objective.roomName
  )
    return base("route-unavailable");
  if (
    candidate.threatRisk > policy.maximumThreatRisk ||
    route.risk > policy.maximumThreatRisk ||
    candidate.donor !== "healthy"
  )
    return base("threat-risk");
  const controller = candidate.intel.record.controller;
  if (controller === null) return base("controller-missing");
  let current = 0;
  if (candidate.controller === "available") {
    if (controller.ownership !== "neutral" || controller.reservationTicksToEnd !== null)
      return base("controller-blocked");
  } else if (candidate.controller === "self-reserved") {
    if (controller.ownership !== "reserved" || !positive(controller.reservationTicksToEnd))
      return base("controller-blocked");
    current = controller.reservationTicksToEnd;
  } else return base("controller-blocked");
  const travel = route.estimate.outboundTicks;
  if (!positive(travel)) return base("route-unavailable");
  const lead = travel + spawnTicks(policy) + policy.replacementSafetyTicks;
  return base(null, current, lead, travel);
}

function budgetFor(
  issuer: string,
  colonyId: string,
  requiredExpiry: number,
  entries: readonly RemoteReservationBudgetEntry[],
  policy: RemoteReservationPolicyV1,
  continuingContract: boolean,
  tick: number,
): BudgetRequest {
  const prior = entries
    .filter(
      (entry) =>
        entry.category === "harvesting-filling" &&
        entry.colonyId === colonyId &&
        entry.issuer === issuer,
    )
    .sort((left, right) => right.revision - left.revision)[0];
  const reusable =
    prior !== undefined &&
    (prior.status === "active" || prior.status === "pending") &&
    (continuingContract
      ? prior.expiresAt > tick
      : prior.expiresAt > requiredExpiry - policy.replacementSafetyTicks - 1);
  return {
    colonyId,
    category: "harvesting-filling",
    issuer,
    revision: reusable ? prior.revision : (prior?.revision ?? 0) + 1,
    expiresAt: reusable ? prior.expiresAt : requiredExpiry,
    energy: { minimum: bodyEnergy(policy), desired: bodyEnergy(policy) },
    cpu: { minimum: policy.cpuMilli, desired: policy.cpuMilli },
    spawn: null,
  };
}

function activeAuthorization(
  request: BudgetRequest,
  entries: readonly RemoteReservationBudgetEntry[],
  policy: RemoteReservationPolicyV1,
): RemoteReservationBudgetEntry | null {
  return (
    entries.find(
      (entry) =>
        entry.category === request.category &&
        entry.colonyId === request.colonyId &&
        entry.issuer === request.issuer &&
        entry.revision === request.revision &&
        entry.expiresAt >= request.expiresAt &&
        entry.status === "active" &&
        entry.grant !== null &&
        entry.grant.energy >= bodyEnergy(policy) &&
        entry.grant.cpu >= policy.cpuMilli,
    ) ?? null
  );
}

function hasActiveAuthorization(
  request: BudgetRequest,
  entries: readonly RemoteReservationBudgetEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.category === request.category &&
      entry.colonyId === request.colonyId &&
      entry.issuer === request.issuer &&
      entry.revision === request.revision &&
      entry.status === "active",
  );
}

function contractFor(
  item: RemoteReservationObjectiveEvidence,
  budget: BudgetRequest,
  sequence: number,
  modeledWorkTicks: number,
  routeTravelTicks: number,
  tick: number,
  policy: RemoteReservationPolicyV1,
): WorkContractRequest {
  const controller = item.candidate.intel.record?.controller;
  const route = item.candidate.route.plan;
  if (controller === null || controller === undefined || route === null)
    throw new Error("validated remote reservation evidence disappeared");
  return freeze({
    budgetBinding: { category: budget.category, issuer: budget.issuer },
    conditions: {
      cancellation: "portfolio-or-controller-blocked",
      failure: "bounded-command-retry-exhausted",
      success: "reservation-target-reached",
    },
    deadline: budget.expiresAt - 1,
    earliestStart: tick,
    estimatedWorkTicks: modeledWorkTicks,
    execution: {
      action: "reserve-controller",
      completion: "work-complete",
      counterpartId: null,
      originRoomName: item.objective.donorColonyId,
      resourceType: null,
      routeRoomNames: Object.freeze([...route.roomNames]),
      routeTravelTicks,
      signText: policy.signText,
      targetReservationTicks: policy.reservationTargetTicks,
      version: 4,
    },
    expiresAt: budget.expiresAt,
    issuer: budget.issuer,
    issuerKey: controller.id,
    issuerSequence: sequence,
    kind: "reserve",
    leasePolicy: {
      duration: Math.min(policy.claimCreepLifetime, budget.expiresAt - tick),
      switchingPenalty: routeTravelTicks,
      ttlSafetyMargin: policy.replacementSafetyTicks,
    },
    maxAssignmentCost: routeTravelTicks + policy.replacementSafetyTicks,
    owner: { id: item.objective.donorColonyId, kind: "colony" },
    preconditionKeys: ["fresh-remote-controller", "funded-positive-portfolio", "safe-ready-route"],
    priority: { class: "speculation", value: 800 },
    quantity: modeledWorkTicks,
    range: 1,
    requiredCapability: {
      attack: 0,
      carry: 0,
      claim: policy.claimParts,
      heal: 0,
      move: policy.moveParts,
      rangedAttack: 0,
      tough: 0,
      work: 0,
    },
    target: { roomName: item.objective.roomName, x: controller.pos.x, y: controller.pos.y },
    targetId: controller.id,
  });
}

function compatible(existing: ContractPlanningRecord, desired: WorkContractRequest): boolean {
  const terms = existing.execution;
  const desiredTerms = desired.execution;
  return (
    terms.version === 4 &&
    desiredTerms?.version === 4 &&
    existing.targetId === desired.targetId &&
    existing.owner.kind === "colony" &&
    existing.owner.id === desired.owner.id &&
    terms.originRoomName === desiredTerms.originRoomName &&
    terms.routeTravelTicks === desiredTerms.routeTravelTicks &&
    terms.signText === desiredTerms.signText &&
    terms.targetReservationTicks === desiredTerms.targetReservationTicks &&
    arraysEqual(terms.routeRoomNames, desiredTerms.routeRoomNames)
  );
}

function stopExisting(
  existing: ContractPlanningRecord | undefined,
  reason: string,
  tick: number,
  transitions: ContractTransitionRequest[],
): void {
  if (existing === undefined || existing.state === "suspended") return;
  transitions.push({
    contractId: existing.contractId,
    reason,
    tick,
    to: existing.state === "proposed" ? "cancelled" : "suspended",
  });
}

function completeExisting(
  existing: ContractPlanningRecord | undefined,
  tick: number,
  transitions: ContractTransitionRequest[],
  forced: "cancelled" | null = null,
  suffix = "target-reached",
): void {
  if (existing === undefined) return;
  transitions.push({
    contractId: existing.contractId,
    reason: `remote-reservation-${suffix}`,
    tick,
    to: forced ?? (existing.state === "active" ? "completed" : "cancelled"),
  });
}

function validInput(input: RemoteReservationPlanInput): boolean {
  return (
    nonnegative(input.tick) &&
    Array.isArray(input.objectives) &&
    Array.isArray(input.budgets) &&
    input.budgets.every(validBudgetEntry) &&
    validPolicy(input.policy)
  );
}

function validBudgetEntry(entry: RemoteReservationBudgetEntry): boolean {
  return (
    entry.category.length > 0 &&
    entry.colonyId.length > 0 &&
    entry.issuer.length > 0 &&
    nonnegative(entry.revision) &&
    nonnegative(entry.expiresAt) &&
    ["active", "pending", "consumed", "released", "expired"].includes(entry.status) &&
    (entry.grant === null ||
      (nonnegative(entry.grant.energy) &&
        nonnegative(entry.grant.cpu) &&
        (entry.grant.spawn === null ||
          (nonnegative(entry.grant.spawn.startTick) &&
            nonnegative(entry.grant.spawn.endTick) &&
            entry.grant.spawn.endTick > entry.grant.spawn.startTick))))
  );
}

function validPolicy(policy: RemoteReservationPolicyV1): boolean {
  return (
    policy.revision.length > 0 &&
    policy.claimParts === 2 &&
    policy.moveParts === 2 &&
    policy.claimPartEnergy === 600 &&
    policy.movePartEnergy === 50 &&
    policy.spawnTicksPerPart === 3 &&
    policy.claimCreepLifetime === 600 &&
    positive(policy.reservationTargetTicks) &&
    policy.reservationTargetTicks <= REMOTE_RESERVATION_LIMITS.reservationMaximumTicks &&
    nonnegative(policy.replacementSafetyTicks) &&
    positive(policy.cpuMilli) &&
    nonnegative(policy.maximumThreatRisk) &&
    positive(policy.maximumIntelAgeTicks) &&
    positive(policy.maximumCommandAttempts) &&
    positive(policy.retryInitialDelayTicks) &&
    positive(policy.retryMaximumDelayTicks) &&
    (policy.signText === null || policy.signText.length <= 100)
  );
}

function issuerFor({ objective }: RemoteReservationObjectiveEvidence): string {
  return `${ISSUER_PREFIX}${objective.donorColonyId}/${objective.roomName}`;
}
function issuerRoomName(issuer: string): string {
  return issuer.slice(issuer.lastIndexOf("/") + 1) || "unknown";
}
function bodyEnergy(policy: RemoteReservationPolicyV1): number {
  return policy.claimParts * policy.claimPartEnergy + policy.moveParts * policy.movePartEnergy;
}
function spawnTicks(policy: RemoteReservationPolicyV1): number {
  return (policy.claimParts + policy.moveParts) * policy.spawnTicksPerPart;
}
function disposition(
  item: RemoteReservationObjectiveEvidence,
  reason: RemoteReservationReason,
  evaluation: Pick<Evaluation, "currentReservationTicks" | "leadTicks">,
): RemoteReservationDisposition {
  return {
    roomName: item.objective.roomName,
    reason,
    currentReservationTicks: evaluation.currentReservationTicks,
    leadTicks: evaluation.leadTicks,
  };
}
function compareObjective(
  left: RemoteReservationObjectiveEvidence,
  right: RemoteReservationObjectiveEvidence,
): number {
  return (
    compare(left.objective.roomName, right.objective.roomName) ||
    compare(left.objective.donorColonyId, right.objective.donorColonyId)
  );
}
function compareBudget(left: BudgetRequest, right: BudgetRequest): number {
  return compare(left.colonyId, right.colonyId) || compare(left.issuer, right.issuer);
}
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function metrics(
  objectives: number,
  due: number,
  budgets: readonly BudgetRequest[],
  requests: readonly WorkContractRequest[],
  transitions: readonly ContractTransitionRequest[],
  retries: number,
): RemoteReservationMetrics {
  return {
    objectives,
    due,
    budgeted: budgets.length,
    contracts: requests.length,
    suspended: transitions.filter(({ to }) => to === "suspended").length,
    completed: transitions.filter(({ to }) => to === "completed" || to === "cancelled").length,
    retries,
  };
}
function emptyPlan(status: RemoteReservationPlan["status"]): RemoteReservationPlan {
  return freeze({
    status,
    budgetRequests: [],
    contractRequests: [],
    transitions: [],
    dispositions: [],
    metrics: {
      objectives: 0,
      due: 0,
      budgeted: 0,
      contracts: 0,
      suspended: 0,
      completed: 0,
      retries: 0,
    },
  });
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
