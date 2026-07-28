import { classifyPlayerRelation } from "../config";
import type {
  ContractTransitionRequest,
  LeaseTravelOverride,
  LeasedWorkExecution,
} from "../contracts";
import { INTEL_LIMITS, type RoomIntelHostile } from "../world/intel";
import {
  REMOTE_SAFETY_LIMITS,
  type RemoteSafetyAssessment,
  type RemoteSafetyAssessmentInput,
  type RemoteSafetyAssessmentResult,
  type RemoteSafetyEvidence,
  type RemoteSafetyMetrics,
  type RemoteEvacuationDisposition,
  type RemoteEvacuationMetrics,
  type RemoteEvacuationPlan,
  type RemoteEvacuationPlanInput,
  type RemoteSafetyPolicyV1,
  type RemoteSafetyReason,
} from "./safety-contracts";

const REMOTE_SAFETY_REASONS: readonly RemoteSafetyReason[] = Object.freeze([
  "confidence-low",
  "credible-hostile",
  "excluded-presence",
  "harmless-presence",
  "intel-partial",
  "intel-stale",
  "intel-unavailable",
  "invader-core",
  "loss-risk",
  "recent-attack",
  "route-threat",
  "safe",
]);

interface EvaluatedSafety {
  readonly assessment: RemoteSafetyAssessment;
  readonly evidence: RemoteSafetyEvidence;
  readonly excludedCreeps: number;
  readonly harmlessCreeps: number;
}

/**
 * Projects diplomacy-qualified remote danger into the existing RemotePortfolio risk input.
 * RemotePortfolio remains the lifecycle/capacity owner; this function persists and commands nothing.
 */
export function assessRemoteSafety(
  input: RemoteSafetyAssessmentInput,
): RemoteSafetyAssessmentResult {
  if (assessmentLimitExceeded(input)) return empty("limit-exceeded");
  if (!validInput(input)) return empty("invalid-input");
  const requiredCpu = input.evidence.length * input.policy.assessmentCpuMilli;
  if (requiredCpu > input.availableCpuMilli) return empty("cpu-budget");

  const ordered = [...input.evidence].sort((left, right) =>
    compare(left.candidate.roomName, right.candidate.roomName),
  );
  if (new Set(ordered.map(({ candidate }) => candidate.roomName)).size !== ordered.length)
    return empty("invalid-input");
  const evaluated = ordered.map((evidence) => evaluate(evidence, input));
  const candidates = evaluated.map(({ assessment, evidence }) =>
    deepFreeze({
      ...evidence.candidate,
      threatRisk: Math.max(evidence.candidate.threatRisk, assessment.threatRisk),
    }),
  );
  return deepFreeze({
    assessments: evaluated.map(({ assessment }) => assessment),
    candidates,
    metrics: metrics(evaluated, requiredCpu),
    status: "ready" as const,
  });
}

/**
 * Redirects existing leased remote actors through a separately safety-qualified return route.
 * Loaded V6 delivery already following that route stays under LogisticsPlanner ownership.
 */
export function planRemoteEvacuations(input: RemoteEvacuationPlanInput): RemoteEvacuationPlan {
  if (evacuationLimitExceeded(input)) return emptyEvacuation("limit-exceeded");
  if (!validEvacuationInput(input)) return emptyEvacuation("invalid-input");
  if (input.execution.status !== "ready") return emptyEvacuation("unavailable");
  const assessmentByRoom = uniqueMap(input.assessments, ({ roomName }) => roomName);
  const evidenceByRoom = uniqueMap(input.evidence, ({ candidate }) => candidate.roomName);
  const actorById = uniqueMap(input.actors, ({ id }) => id);
  const portfolioByRoom = uniqueMap(input.portfolioDispositions ?? [], ({ roomName }) => roomName);
  if (
    assessmentByRoom === null ||
    evidenceByRoom === null ||
    actorById === null ||
    portfolioByRoom === null ||
    assessmentByRoom.size !== evidenceByRoom.size ||
    [...assessmentByRoom].some(
      ([roomName, assessment]) =>
        assessment.evidenceRevision !== evidenceByRoom.get(roomName)?.candidate.evidenceRevision,
    )
  )
    return emptyEvacuation("invalid-input");

  const dispositions: RemoteEvacuationDisposition[] = [];
  const overrides: LeaseTravelOverride[] = [];
  const transitions: ContractTransitionRequest[] = [];
  for (const lease of [...input.execution.leases].sort(compareLease)) {
    const identity = remoteLeaseIdentity(lease);
    if (identity === null) continue;
    const assessment = assessmentByRoom.get(identity.remoteRoomName);
    const evidence = evidenceByRoom.get(identity.remoteRoomName);
    const portfolio = portfolioByRoom.get(identity.remoteRoomName);
    const evacuationActive =
      assessment !== undefined &&
      (assessment.threatRisk > 0 ||
        portfolio?.state === "threatened" ||
        portfolio?.state === "suspended" ||
        portfolio?.state === "cooldown");
    if (assessment === undefined || evidence === undefined || !evacuationActive) continue;
    const actor = actorById.get(lease.actorId);
    if (actor === undefined) {
      dispositions.push(evacuationDisposition(lease, identity.remoteRoomName, "actor-lost"));
      transitions.push(stopTransition(lease, input.tick, "actor-lost"));
      continue;
    }
    if (
      actor.pos.roomName === identity.donorRoomName &&
      lease.execution.version === 6 &&
      lease.execution.stage === "deliver"
    ) {
      dispositions.push(evacuationDisposition(lease, identity.remoteRoomName, "cargo-returning"));
      continue;
    }
    if (actor.pos.roomName === identity.donorRoomName) {
      dispositions.push(evacuationDisposition(lease, identity.remoteRoomName, "evacuated"));
      overrides.push(
        holdOverride(lease, actor.pos.roomName, input.policy, "remote-safety-evacuated"),
      );
      transitions.push(stopTransition(lease, input.tick, "evacuated"));
      continue;
    }
    const route = evidence.evacuationRoute.plan;
    if (
      evidence.evacuationRoute.status !== "ready" ||
      route === null ||
      route.originRoomName !== identity.remoteRoomName ||
      route.destinationRoomName !== identity.donorRoomName ||
      route.roomNames.length === 0 ||
      route.roomNames.length > REMOTE_SAFETY_LIMITS.maximumRouteRooms ||
      route.roomNames[route.roomNames.length - 1] !== identity.donorRoomName ||
      route.risk > 0 ||
      route.estimate.outboundTicks <= 0
    ) {
      dispositions.push(evacuationDisposition(lease, identity.remoteRoomName, "route-unavailable"));
      overrides.push(
        holdOverride(lease, actor.pos.roomName, input.policy, "remote-safety-route-unavailable"),
      );
      transitions.push(stopTransition(lease, input.tick, "route-unavailable"));
      continue;
    }
    if (lease.execution.version === 6 && lease.execution.stage === "deliver") {
      const current = lease.execution.deliverRouteRoomNames;
      const alreadyReturning =
        lease.execution.deliverOriginRoomName === route.originRoomName &&
        sameStrings(current, route.roomNames);
      if (alreadyReturning) {
        dispositions.push(evacuationDisposition(lease, identity.remoteRoomName, "cargo-returning"));
        continue;
      }
    }
    overrides.push(
      deepFreeze({
        actorId: lease.actorId,
        contractId: lease.contractId,
        contractRevision: lease.revision,
        deadline: lease.deadline,
        destinationRoomName: identity.donorRoomName,
        mode: "travel",
        originRoomName: identity.remoteRoomName,
        priority: input.policy.evacuationMovementPriority,
        reason: `remote-safety-${assessment.reason}`,
        routeRoomNames: Object.freeze([...route.roomNames]),
        routeTravelTicks: route.estimate.outboundTicks,
      }),
    );
    dispositions.push(evacuationDisposition(lease, identity.remoteRoomName, "evacuating"));
  }
  dispositions.sort(compareEvacuationDisposition);
  overrides.sort(compareOverride);
  transitions.sort((left, right) => compare(left.contractId, right.contractId));
  return deepFreeze({
    dispositions,
    metrics: evacuationMetrics(dispositions),
    overrides,
    status: "ready" as const,
    transitions,
  });
}

function evaluate(
  evidence: RemoteSafetyEvidence,
  input: RemoteSafetyAssessmentInput,
): EvaluatedSafety {
  const record = evidence.candidate.intel.record;
  let credible = 0;
  let excluded = 0;
  let harmless = 0;
  for (const hostile of record?.hostiles ?? []) {
    const relation = classifyPlayerRelation(input.config, {
      tick: input.tick,
      username: hostile.ownerUsername,
    });
    if (relation.targetingCeiling === "excluded") excluded += 1;
    else if (offensiveParts(hostile) > 0) credible += 1;
    else harmless += 1;
  }
  const reason = assessmentReason(evidence, input, credible, excluded, harmless);
  const safe =
    reason === "safe" || reason === "excluded-presence" || reason === "harmless-presence";
  return {
    assessment: deepFreeze({
      confidenceBasisPoints: evidence.confidenceBasisPoints,
      evidenceRevision: evidence.candidate.evidenceRevision,
      reason,
      recentLossBasisPoints: evidence.recentLossBasisPoints,
      roomName: evidence.candidate.roomName,
      threatRisk: safe ? 0 : input.policy.threatRisk,
    }),
    evidence,
    excludedCreeps: excluded,
    harmlessCreeps: harmless,
  };
}

function assessmentReason(
  evidence: RemoteSafetyEvidence,
  input: RemoteSafetyAssessmentInput,
  credible: number,
  excluded: number,
  harmless: number,
): RemoteSafetyReason {
  const { candidate } = evidence;
  const intel = candidate.intel;
  const record = intel.record;
  if (intel.freshness === "unknown" || record === null) return "intel-unavailable";
  if (
    intel.freshness === "stale" ||
    intel.freshness === "expired" ||
    record.observedAt > input.tick ||
    input.tick - record.observedAt > input.policy.maximumIntelAgeTicks
  )
    return "intel-stale";
  if (intel.quality !== "complete" || !record.complete) return "intel-partial";
  const route = candidate.route.plan;
  if (
    candidate.threatRisk > 0 ||
    candidate.route.status === "unsafe-route" ||
    (route !== null && route.risk > 0)
  )
    return "route-threat";
  if (hasRecentAttack(evidence, input)) return "recent-attack";
  if (
    record.structures.some(
      ({ invaderCore }) =>
        invaderCore !== null &&
        (invaderCore.ticksToDeploy === null ||
          invaderCore.ticksToDeploy <= input.policy.invaderCoreDeploymentLeadTicks),
    )
  )
    return "invader-core";
  if (credible > 0) return "credible-hostile";
  if (evidence.confidenceBasisPoints < input.policy.minimumConfidenceBasisPoints)
    return "confidence-low";
  if (evidence.recentLossBasisPoints > input.policy.maximumRecentLossBasisPoints)
    return "loss-risk";
  if (excluded > 0) return "excluded-presence";
  if (harmless > 0) return "harmless-presence";
  return "safe";
}

function hasRecentAttack(
  evidence: RemoteSafetyEvidence,
  input: RemoteSafetyAssessmentInput,
): boolean {
  const record = evidence.candidate.intel.record;
  if (
    record === null ||
    record.eventsObservedAt === null ||
    input.tick - record.eventsObservedAt > input.policy.maximumIntelAgeTicks
  )
    return false;
  const hostiles = new Map(record.hostiles.map((hostile) => [hostile.id, hostile]));
  return record.events.some((event) => {
    if (event.event !== 1 && event.event !== 3) return false;
    const actor = hostiles.get(event.objectId);
    if (actor === undefined) return true;
    return (
      classifyPlayerRelation(input.config, {
        tick: input.tick,
        username: actor.ownerUsername,
      }).targetingCeiling !== "excluded"
    );
  });
}

function offensiveParts(hostile: RoomIntelHostile): number {
  return (
    hostile.body.attack.active +
    hostile.body.claim.active +
    hostile.body.rangedAttack.active +
    hostile.body.work.active
  );
}

function metrics(evaluated: readonly EvaluatedSafety[], cpuMilli: number): RemoteSafetyMetrics {
  return {
    assessed: evaluated.length,
    cpuMilli,
    credibleThreats: evaluated.filter(({ assessment }) => assessment.reason === "credible-hostile")
      .length,
    excludedCreeps: evaluated.reduce((sum, value) => sum + value.excludedCreeps, 0),
    harmlessCreeps: evaluated.reduce((sum, value) => sum + value.harmlessCreeps, 0),
    unsafe: evaluated.filter(({ assessment }) => assessment.threatRisk > 0).length,
  };
}

function remoteLeaseIdentity(
  lease: LeasedWorkExecution,
): { readonly donorRoomName: string; readonly remoteRoomName: string } | null {
  if (lease.execution.version === 4 || lease.execution.version === 5)
    return {
      donorRoomName: lease.execution.originRoomName,
      remoteRoomName: lease.target.roomName,
    };
  if (lease.execution.version !== 6) return null;
  return {
    donorRoomName: lease.execution.sinkPosition.roomName,
    remoteRoomName: lease.execution.sourcePosition.roomName,
  };
}

function evacuationDisposition(
  lease: LeasedWorkExecution,
  roomName: string,
  reason: RemoteEvacuationDisposition["reason"],
): RemoteEvacuationDisposition {
  return {
    actorId: lease.actorId,
    contractId: lease.contractId,
    reason,
    roomName,
  };
}

function holdOverride(
  lease: LeasedWorkExecution,
  roomName: string,
  policy: RemoteSafetyPolicyV1,
  reason: string,
): LeaseTravelOverride {
  return deepFreeze({
    actorId: lease.actorId,
    contractId: lease.contractId,
    contractRevision: lease.revision,
    deadline: lease.deadline,
    destinationRoomName: roomName,
    mode: "hold",
    originRoomName: roomName,
    priority: policy.evacuationMovementPriority,
    reason,
    routeRoomNames: [],
    routeTravelTicks: 0,
  });
}

function stopTransition(
  lease: LeasedWorkExecution,
  tick: number,
  reason: "actor-lost" | "evacuated" | "route-unavailable",
): ContractTransitionRequest {
  return {
    contractId: lease.contractId,
    reason: `remote-safety-${reason}`,
    tick,
    to: "suspended",
  };
}

function evacuationMetrics(
  dispositions: readonly RemoteEvacuationDisposition[],
): RemoteEvacuationMetrics {
  const count = (reason: RemoteEvacuationDisposition["reason"]): number =>
    dispositions.filter((value) => value.reason === reason).length;
  return {
    actors: dispositions.length,
    cargoReturning: count("cargo-returning"),
    evacuated: count("evacuated"),
    evacuating: count("evacuating"),
    lost: count("actor-lost"),
    routeUnavailable: count("route-unavailable"),
  };
}

function compareLease(left: LeasedWorkExecution, right: LeasedWorkExecution): number {
  return compare(left.actorId, right.actorId) || compare(left.contractId, right.contractId);
}
function compareEvacuationDisposition(
  left: RemoteEvacuationDisposition,
  right: RemoteEvacuationDisposition,
): number {
  return compare(left.actorId, right.actorId) || compare(left.contractId, right.contractId);
}
function compareOverride(left: LeaseTravelOverride, right: LeaseTravelOverride): number {
  return compare(left.actorId, right.actorId) || compare(left.contractId, right.contractId);
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function uniqueMap<Value>(
  values: readonly Value[],
  keyOf: (value: Value) => string,
): Map<string, Value> | null {
  const result = new Map<string, Value>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) return null;
    result.set(key, value);
  }
  return result;
}

function assessmentLimitExceeded(input: unknown): boolean {
  return (
    isRecord(input) &&
    Array.isArray(input.evidence) &&
    input.evidence.length > REMOTE_SAFETY_LIMITS.maximumEvidencePerTick
  );
}

function evacuationLimitExceeded(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const execution = input.execution;
  return (
    (Array.isArray(input.evidence) &&
      input.evidence.length > REMOTE_SAFETY_LIMITS.maximumEvidencePerTick) ||
    (Array.isArray(input.assessments) &&
      input.assessments.length > REMOTE_SAFETY_LIMITS.maximumEvidencePerTick) ||
    (Array.isArray(input.portfolioDispositions) &&
      input.portfolioDispositions.length > REMOTE_SAFETY_LIMITS.maximumPortfolioDispositions) ||
    (Array.isArray(input.actors) && input.actors.length > 64) ||
    (isRecord(execution) && Array.isArray(execution.leases) && execution.leases.length > 64)
  );
}

function validEvacuationInput(input: unknown): input is RemoteEvacuationPlanInput {
  if (!isRecord(input)) return false;
  const value = input as unknown as RemoteEvacuationPlanInput;
  return (
    nonnegative(value.tick) &&
    Array.isArray(value.actors) &&
    value.actors.length <= 64 &&
    Array.isArray(value.assessments) &&
    value.assessments.length <= REMOTE_SAFETY_LIMITS.maximumEvidencePerTick &&
    value.assessments.every(validAssessment) &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= REMOTE_SAFETY_LIMITS.maximumEvidencePerTick &&
    value.evidence.every(validEvidence) &&
    isRecord(value.execution) &&
    Array.isArray(value.execution.leases) &&
    value.execution.leases.length <= 64 &&
    (value.portfolioDispositions === undefined ||
      (Array.isArray(value.portfolioDispositions) &&
        value.portfolioDispositions.length <= REMOTE_SAFETY_LIMITS.maximumPortfolioDispositions)) &&
    validPolicy(value.policy)
  );
}

function validInput(input: unknown): input is RemoteSafetyAssessmentInput {
  if (!isRecord(input)) return false;
  const value = input as unknown as RemoteSafetyAssessmentInput;
  return (
    nonnegative(value.tick) &&
    nonnegative(value.availableCpuMilli) &&
    isRecord(value.config) &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= REMOTE_SAFETY_LIMITS.maximumEvidencePerTick &&
    value.evidence.every(validEvidence) &&
    validPolicy(value.policy)
  );
}

function validEvidence(value: unknown): value is RemoteSafetyEvidence {
  if (!isRecord(value)) return false;
  const candidate = value.candidate;
  const evacuationRoute = value.evacuationRoute;
  if (!isRecord(candidate) || !isRecord(evacuationRoute)) return false;
  const intel = candidate.intel;
  const route = candidate.route;
  if (
    !isRecord(intel) ||
    !validRouteEvidence(route) ||
    !validRouteEvidence(evacuationRoute) ||
    intel.roomName !== candidate.roomName ||
    !["current", "fresh", "stale", "expired", "unknown"].includes(String(intel.freshness)) ||
    !["complete", "partial", "unknown"].includes(String(intel.quality))
  )
    return false;
  const record = intel.record;
  if (
    record !== null &&
    (!isRecord(record) ||
      record.roomName !== candidate.roomName ||
      typeof record.complete !== "boolean" ||
      !nonnegative(record.observedAt) ||
      (record.eventsObservedAt !== null && !nonnegative(record.eventsObservedAt)) ||
      !Array.isArray(record.hostiles) ||
      record.hostiles.length > INTEL_LIMITS.maximumHostilesPerRoom ||
      !Array.isArray(record.events) ||
      record.events.length > INTEL_LIMITS.maximumEventsPerRoom ||
      !Array.isArray(record.structures) ||
      record.structures.length > INTEL_LIMITS.maximumStructuresPerRoom ||
      !record.hostiles.every(validHostileEvidence) ||
      !record.events.every(validEventEvidence) ||
      !record.structures.every(validStructureEvidence))
  )
    return false;
  return (
    nonnegative(value.confidenceBasisPoints) &&
    value.confidenceBasisPoints <= 10_000 &&
    nonnegative(value.recentLossBasisPoints) &&
    value.recentLossBasisPoints <= 10_000 &&
    roomName(candidate.roomName) &&
    roomName(candidate.donorColonyId) &&
    candidate.roomName !== candidate.donorColonyId &&
    identity(candidate.evidenceRevision) &&
    nonnegative(candidate.threatRisk) &&
    candidate.threatRisk <= REMOTE_SAFETY_LIMITS.maximumThreatRisk
  );
}

function validAssessment(value: unknown): value is RemoteSafetyAssessment {
  if (!isRecord(value)) return false;
  return (
    roomName(value.roomName) &&
    identity(value.evidenceRevision) &&
    safetyReason(value.reason) &&
    nonnegative(value.threatRisk) &&
    value.threatRisk <= REMOTE_SAFETY_LIMITS.maximumThreatRisk &&
    nonnegative(value.confidenceBasisPoints) &&
    value.confidenceBasisPoints <= 10_000 &&
    nonnegative(value.recentLossBasisPoints) &&
    value.recentLossBasisPoints <= 10_000
  );
}

function safetyReason(value: unknown): value is RemoteSafetyReason {
  return typeof value === "string" && REMOTE_SAFETY_REASONS.includes(value as RemoteSafetyReason);
}

function validRouteEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !["ready", "stale-route", "unsafe-route", "no-route", "deferred", "invalid"].includes(
      String(value.status),
    )
  )
    return false;
  if (value.plan === null) return true;
  if (!isRecord(value.plan)) return false;
  const estimate = value.plan.estimate;
  return (
    roomName(value.plan.originRoomName) &&
    roomName(value.plan.destinationRoomName) &&
    nonnegative(value.plan.risk) &&
    Array.isArray(value.plan.roomNames) &&
    value.plan.roomNames.length <= REMOTE_SAFETY_LIMITS.maximumRouteRooms &&
    value.plan.roomNames.every(roomName) &&
    isRecord(estimate) &&
    nonnegative(estimate.outboundTicks)
  );
}

function validHostileEvidence(value: unknown): boolean {
  if (!isRecord(value) || !identity(value.id) || !identity(value.ownerUsername)) return false;
  const body = value.body;
  if (!isRecord(body)) return false;
  return ["attack", "claim", "rangedAttack", "work"].every((part) => {
    const count = body[part];
    return isRecord(count) && nonnegative(count.active);
  });
}
function validEventEvidence(value: unknown): boolean {
  return isRecord(value) && nonnegative(value.event) && identity(value.objectId);
}
function validStructureEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const core = value.invaderCore;
  return (
    core === null ||
    (isRecord(core) &&
      nonnegative(core.level) &&
      (core.ticksToDeploy === null || nonnegative(core.ticksToDeploy)))
  );
}

function validPolicy(policy: unknown): policy is RemoteSafetyPolicyV1 {
  if (!isRecord(policy)) return false;
  return (
    policy.schemaVersion === 1 &&
    identity(policy.revision) &&
    positive(policy.assessmentCpuMilli) &&
    policy.assessmentCpuMilli <= REMOTE_SAFETY_LIMITS.maximumAssessmentCpuMilli &&
    positive(policy.evacuationMovementPriority) &&
    policy.evacuationMovementPriority <= REMOTE_SAFETY_LIMITS.maximumMovementPriority &&
    nonnegative(policy.maximumIntelAgeTicks) &&
    nonnegative(policy.maximumRecentLossBasisPoints) &&
    policy.maximumRecentLossBasisPoints <= 10_000 &&
    nonnegative(policy.minimumConfidenceBasisPoints) &&
    policy.minimumConfidenceBasisPoints <= 10_000 &&
    nonnegative(policy.invaderCoreDeploymentLeadTicks) &&
    positive(policy.threatRisk) &&
    policy.threatRisk <= REMOTE_SAFETY_LIMITS.maximumThreatRisk
  );
}

function emptyEvacuation(
  status: Exclude<RemoteEvacuationPlan["status"], "ready">,
): RemoteEvacuationPlan {
  return deepFreeze({
    dispositions: [],
    metrics: {
      actors: 0,
      cargoReturning: 0,
      evacuated: 0,
      evacuating: 0,
      lost: 0,
      routeUnavailable: 0,
    },
    overrides: [],
    status,
    transitions: [],
  });
}

function empty(
  status: Exclude<RemoteSafetyAssessmentResult["status"], "ready">,
): RemoteSafetyAssessmentResult {
  return deepFreeze({
    assessments: [],
    candidates: [],
    metrics: {
      assessed: 0,
      cpuMilli: 0,
      credibleThreats: 0,
      excludedCreeps: 0,
      harmlessCreeps: 0,
      unsafe: 0,
    },
    status,
  });
}

function roomName(value: unknown): value is string {
  return typeof value === "string" && /^(W|E)\d+(N|S)\d+$/u.test(value) && value.length <= 16;
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= REMOTE_SAFETY_LIMITS.maximumIdentityCodeUnits &&
    value === value.trim()
  );
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
