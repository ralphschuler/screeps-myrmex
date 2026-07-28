import type { MemoryManager, MemoryStageResult } from "../state/memory";
import { reduceRemoteAccounting } from "./accounting";
import type { RemoteAccountingResult, RemoteProfitabilitySummary } from "./accounting-contracts";
import { DEFAULT_REMOTE_ACCOUNTING_POLICY_V1 } from "./accounting-policy";
import {
  REMOTE_COST_COMPONENTS,
  REMOTE_PORTFOLIO_LIMITS,
  REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION,
  type RemoteCandidateEvidence,
  type RemoteCapacityCommitment,
  type RemoteForecast,
  type RemotePortfolioDisposition,
  type RemotePortfolioInput,
  type RemotePortfolioMetrics,
  type RemotePortfolioObjective,
  type RemotePortfolioOwnerV2,
  type RemotePortfolioPolicyV1,
  type RemotePortfolioReason,
  type RemotePortfolioRecord,
  type RemotePortfolioResult,
} from "./contracts";
import {
  canonicalRemotePortfolioOwner,
  remotePortfolioOwnerEquals,
  resolveRemotePortfolioOwner,
} from "./persistence";

interface CandidateEvaluation {
  readonly candidate: RemoteCandidateEvidence;
  readonly forecast: RemoteForecast;
  readonly eligible: boolean;
  readonly profitable: boolean;
  readonly reason: RemotePortfolioReason;
}

interface CapacityUsage {
  energy: number;
  spawnTicks: number;
  cpuMilli: number;
  memoryCodeUnits: number;
  activeRemotes: number;
}

/**
 * Sole persistent remote lifecycle, full-cost forecast, ranking, and portfolio-capacity authority.
 *
 * This authority emits funded objectives only. Reservation, mining, hauling, evacuation, movement,
 * spawning, contracts, and Screeps commands remain with their existing or later roadmap owners.
 */
export class RemotePortfolio {
  public plan(input: RemotePortfolioInput): RemotePortfolioResult {
    const rawInput: unknown = input;
    if (!isRecord(rawInput)) return preservedResult("invalid-input");
    const resolved = resolveRemotePortfolioOwner(input.owner);
    if (resolved.owner === null) {
      return emptyResult(
        resolved.status === "future-schema" ? "owner-future-schema" : "owner-malformed",
      );
    }
    const current = resolved.owner;
    if (
      !validInput(input) ||
      current.records.some(({ lastEvaluatedTick }) => lastEvaluatedTick > input.tick)
    )
      return preservedResult("invalid-input");
    const lifecycleByRoom = new Map(current.records.map((record) => [record.roomName, record]));
    const accounting = reduceRemoteAccounting({
      tick: input.tick,
      previous: current.accounting,
      observations: input.accounting ?? [],
      policy: input.accountingPolicy ?? DEFAULT_REMOTE_ACCOUNTING_POLICY_V1,
      protectedRoomNames: current.accounting.flatMap(({ roomName }) => {
        const lifecycle = lifecycleByRoom.get(roomName);
        return lifecycle !== undefined &&
          lifecycle.state !== "candidate" &&
          lifecycle.state !== "retired"
          ? [roomName]
          : [];
      }),
    });
    if (accounting.status !== "ready") {
      return preservedResult(accounting.status);
    }
    const accountingByRoom = new Map(
      accounting.summaries.map((summary) => [summary.roomName, summary]),
    );
    if (input.candidates.length > REMOTE_PORTFOLIO_LIMITS.maximumCandidatesPerTick) {
      return preservedResult("limit-exceeded");
    }

    const previousByRoom = new Map(current.records.map((record) => [record.roomName, record]));
    const evaluations: CandidateEvaluation[] = [];
    const seenRooms = new Set<string>();
    for (const candidate of input.candidates) {
      if (
        !validCandidate(candidate) ||
        candidate.expiresAt - input.tick > REMOTE_PORTFOLIO_LIMITS.maximumDeadlineTicks ||
        seenRooms.has(candidate.roomName)
      ) {
        return preservedResult("invalid-input");
      }
      seenRooms.add(candidate.roomName);
      const forecast = forecastFor(candidate);
      if (forecast === null) return preservedResult("invalid-input");
      evaluations.push(
        evaluate(
          candidate,
          forecast,
          input,
          previousByRoom.get(candidate.roomName),
          accountingByRoom.get(candidate.roomName),
        ),
      );
    }

    const selected = selectCandidates(evaluations, previousByRoom, input);
    const nextRecords: RemotePortfolioRecord[] = [];
    for (const evaluation of evaluations) {
      const previous = previousByRoom.get(evaluation.candidate.roomName) ?? null;
      const selectionReason = selected.rejections.get(evaluation.candidate.roomName);
      const record = selected.rooms.has(evaluation.candidate.roomName)
        ? fundedRecord(previous, evaluation, input.tick, input.policy)
        : deniedRecord(
            previous,
            evaluation,
            selectionReason ?? evaluation.reason,
            input.tick,
            input.policy,
          );
      nextRecords.push(record);
    }
    for (const previous of current.records) {
      if (!seenRooms.has(previous.roomName)) {
        nextRecords.push(missingRecord(previous, input.tick, input.policy));
      }
    }

    const bounded = fitRecordBound(nextRecords, current.revision + 1, accounting.records);
    if (bounded === null) return preservedResult("memory-budget");
    const transitions = bounded.filter((record) => {
      const previous = previousByRoom.get(record.roomName);
      return previous === undefined || previous.state !== record.state;
    }).length;
    if (transitions > REMOTE_PORTFOLIO_LIMITS.maximumTransitionsPerTick) {
      return preservedResult("limit-exceeded");
    }

    const provisional = canonicalRemotePortfolioOwner(
      current.revision + 1,
      bounded,
      accounting.records,
    );
    const initialized = resolved.status === "initialized" || resolved.status === "migrated";
    const changed = initialized || !sameRecords(current, provisional);
    const owner = changed ? provisional : current;
    if (JSON.stringify(owner).length > REMOTE_PORTFOLIO_LIMITS.maximumOwnerCodeUnits) {
      return preservedResult("memory-budget");
    }
    return readyResult(current, owner, changed, evaluations, accounting);
  }

  /** Stages this authority's complete validated owner; only MemoryManager commits the root. */
  public stage(manager: MemoryManager, result: RemotePortfolioResult): MemoryStageResult {
    if (result.status !== "ready" || result.owner === null) {
      throw new TypeError("RemotePortfolio can stage only a ready owner result");
    }
    const transaction = manager.transaction("remotes");
    transaction.replace(result.owner);
    return transaction.stage();
  }
}

function evaluate(
  candidate: RemoteCandidateEvidence,
  forecast: RemoteForecast,
  input: RemotePortfolioInput,
  previous: RemotePortfolioRecord | undefined,
  accounting: RemoteProfitabilitySummary | undefined,
): CandidateEvaluation {
  if (previous?.state === "retired") {
    return {
      candidate,
      forecast,
      eligible: false,
      profitable: forecast.profit >= input.policy.minimumProfitMilliPerTick,
      reason: previous.reasonCode,
    };
  }
  let reason: RemotePortfolioReason = "positive-probe";
  if (candidate.expiresAt <= input.tick) reason = "timeout";
  else if (candidate.intel.freshness === "stale" || candidate.intel.freshness === "expired")
    reason = "stale-intel";
  else if (
    candidate.intel.freshness === "unknown" ||
    candidate.intel.record === null ||
    candidate.intel.roomName !== candidate.roomName
  )
    reason = "intel-unavailable";
  else if (candidate.intel.quality !== "complete" || !candidate.intel.record.complete)
    reason = "partial-intel";
  else if (candidate.intel.record.sources.length === 0) reason = "source-vanished";
  else if (
    candidate.route.status !== "ready" ||
    candidate.route.plan === null ||
    candidate.route.plan.destinationRoomName !== candidate.roomName ||
    candidate.route.plan.originRoomName !== candidate.donorColonyId
  )
    reason = "route-unavailable";
  else if (
    candidate.intel.record.controller === null ||
    (candidate.controller === "available" &&
      candidate.intel.record.controller.ownership !== "neutral") ||
    (candidate.controller === "self-reserved" &&
      candidate.intel.record.controller.ownership !== "reserved") ||
    (candidate.controller !== "available" && candidate.controller !== "self-reserved")
  )
    reason = "controller-blocked";
  else if (candidate.donor !== "healthy")
    reason = candidate.donor === "threatened" ? "threat-risk" : "donor-pressure";
  else if (
    candidate.threatRisk > input.policy.maximumThreatRisk ||
    candidate.route.plan.risk > input.policy.maximumThreatRisk
  )
    reason = "threat-risk";
  else if (forecast.profit < input.policy.minimumProfitMilliPerTick) reason = "negative-value";
  else if (
    accounting?.donorColonyId !== undefined &&
    accounting.donorColonyId !== candidate.donorColonyId
  )
    reason = "accounting-incomplete";
  else if (accounting?.reason === "stale") reason = "accounting-stale";
  else if (accounting?.reason === "incomplete") reason = "accounting-incomplete";
  else if (accounting?.reason === "loss-making") reason = "realized-negative";
  else if (
    previous !== undefined &&
    (previous.state === "suspended" || previous.state === "threatened") &&
    input.tick < previous.resumeAt
  )
    reason = "cooldown-wait";

  const profitable = forecast.profit >= input.policy.minimumProfitMilliPerTick;
  return {
    candidate,
    forecast,
    eligible: reason === "positive-probe",
    profitable,
    reason,
  };
}

function selectCandidates(
  evaluations: readonly CandidateEvaluation[],
  previousByRoom: ReadonlyMap<string, RemotePortfolioRecord>,
  input: RemotePortfolioInput,
): {
  readonly rooms: ReadonlySet<string>;
  readonly rejections: ReadonlyMap<string, RemotePortfolioReason>;
} {
  const eligible = evaluations
    .filter(({ eligible }) => eligible)
    .sort((left, right) => {
      const leftPrior = previousByRoom.get(left.candidate.roomName);
      const rightPrior = previousByRoom.get(right.candidate.roomName);
      const leftScore =
        left.forecast.profit +
        (leftPrior?.state === "active" ? input.policy.activeRetentionBonusMilliPerTick : 0);
      const rightScore =
        right.forecast.profit +
        (rightPrior?.state === "active" ? input.policy.activeRetentionBonusMilliPerTick : 0);
      return (
        rightScore - leftScore ||
        compare(left.candidate.roomName, right.candidate.roomName) ||
        compare(left.candidate.donorColonyId, right.candidate.donorColonyId)
      );
    });
  const rooms = new Set<string>();
  const rejections = new Map<string, RemotePortfolioReason>();
  const availableNewRecords = Math.max(
    0,
    REMOTE_PORTFOLIO_LIMITS.maximumRecords -
      [...previousByRoom.values()].filter(
        ({ state }) => state !== "candidate" && state !== "retired",
      ).length,
  );
  let selectedNewRecords = 0;
  const usage: CapacityUsage = {
    energy: 0,
    spawnTicks: 0,
    cpuMilli: 0,
    memoryCodeUnits: 0,
    activeRemotes: 0,
  };
  for (const evaluation of eligible) {
    if (
      !previousByRoom.has(evaluation.candidate.roomName) &&
      selectedNewRecords >= availableNewRecords
    ) {
      rejections.set(evaluation.candidate.roomName, "capacity-memory");
      continue;
    }
    const reason = capacityReason(usage, evaluation.candidate.commitment, input.capacity);
    if (reason !== null) {
      rejections.set(evaluation.candidate.roomName, reason);
      continue;
    }
    rooms.add(evaluation.candidate.roomName);
    usage.energy += evaluation.candidate.commitment.energy;
    usage.spawnTicks += evaluation.candidate.commitment.spawnTicks;
    usage.cpuMilli += evaluation.candidate.commitment.cpuMilli;
    usage.memoryCodeUnits += evaluation.candidate.commitment.memoryCodeUnits;
    usage.activeRemotes += 1;
    if (!previousByRoom.has(evaluation.candidate.roomName)) selectedNewRecords += 1;
  }
  return { rooms, rejections };
}

function capacityReason(
  usage: CapacityUsage,
  commitment: RemoteCapacityCommitment,
  capacity: RemotePortfolioInput["capacity"],
): RemotePortfolioReason | null {
  if (usage.energy + commitment.energy > capacity.energy) return "capacity-energy";
  if (usage.spawnTicks + commitment.spawnTicks > capacity.spawnTicks) return "capacity-spawn";
  if (usage.cpuMilli + commitment.cpuMilli > capacity.cpuMilli) return "capacity-cpu";
  if (usage.memoryCodeUnits + commitment.memoryCodeUnits > capacity.memoryCodeUnits)
    return "capacity-memory";
  if (usage.activeRemotes + 1 > capacity.activeRemotes) return "capacity-active";
  return null;
}

function fundedRecord(
  previous: RemotePortfolioRecord | null,
  evaluation: CandidateEvaluation,
  tick: number,
  policy: RemotePortfolioPolicyV1,
): RemotePortfolioRecord {
  if (
    previous?.lastEvaluatedTick === tick &&
    (previous.state === "probing" || previous.state === "active" || previous.state === "cooldown")
  ) {
    return nextRecord(
      previous,
      evaluation,
      previous.state,
      previous.reasonCode,
      previous.positiveTicks,
      tick,
      evaluation.candidate.commitment,
      previous.resumeAt,
    );
  }
  let state: RemotePortfolioRecord["state"];
  let reason: RemotePortfolioReason;
  let positiveTicks: number;
  if (previous?.state === "active") {
    state = "active";
    reason = "retained-active";
    positiveTicks = policy.probingTicks;
  } else if (previous?.state === "probing") {
    positiveTicks =
      tick === previous.lastEvaluatedTick + 1
        ? Math.min(policy.probingTicks, previous.positiveTicks + 1)
        : 1;
    state = positiveTicks >= policy.probingTicks ? "active" : "probing";
    reason = state === "active" ? "positive-active" : "positive-probe";
  } else if (previous?.state === "cooldown") {
    positiveTicks =
      tick === previous.lastEvaluatedTick + 1
        ? Math.min(policy.resumptionProbeTicks, previous.positiveTicks + 1)
        : 1;
    state = positiveTicks >= policy.resumptionProbeTicks ? "active" : "cooldown";
    reason = state === "active" ? "resumed-active" : "cooldown-probe";
  } else if (previous?.state === "suspended" || previous?.state === "threatened") {
    state = "cooldown";
    reason = "cooldown-probe";
    positiveTicks = 1;
  } else if (previous?.state === "retired") {
    return previous;
  } else {
    state = "probing";
    reason = "positive-probe";
    positiveTicks = 1;
  }
  return nextRecord(
    previous,
    evaluation,
    state,
    reason,
    positiveTicks,
    tick,
    evaluation.candidate.commitment,
  );
}

function deniedRecord(
  previous: RemotePortfolioRecord | null,
  evaluation: CandidateEvaluation,
  reason: RemotePortfolioReason,
  tick: number,
  policy: RemotePortfolioPolicyV1,
): RemotePortfolioRecord {
  if (previous?.state === "retired") return previous;
  const terminal = reason === "source-vanished" || reason === "timeout";
  const threatened = reason === "threat-risk";
  const previouslyFunded = previous !== null && previous.commitment !== null;
  const state: RemotePortfolioRecord["state"] = terminal
    ? "retired"
    : threatened
      ? "threatened"
      : previouslyFunded || previous?.state === "suspended" || previous?.state === "threatened"
        ? "suspended"
        : "candidate";
  const resumeAt =
    state === "suspended" || state === "threatened"
      ? previous !== null && (previous.state === "suspended" || previous.state === "threatened")
        ? previous.resumeAt
        : tick + policy.suspensionCooldownTicks
      : 0;
  return nextRecord(previous, evaluation, state, reason, 0, tick, null, resumeAt);
}

function missingRecord(
  previous: RemotePortfolioRecord,
  tick: number,
  policy: RemotePortfolioPolicyV1,
): RemotePortfolioRecord {
  if (previous.state === "retired") return previous;
  if (tick >= previous.expiresAt) {
    return reviseRecord(previous, {
      ...previous,
      state: "retired",
      stateSince: tick,
      lastEvaluatedTick: tick,
      reasonCode: "timeout",
      positiveTicks: 0,
      resumeAt: 0,
      commitment: null,
    });
  }
  const state =
    previous.state === "threatened"
      ? "threatened"
      : previous.commitment === null
        ? previous.state
        : "suspended";
  const resumeAt =
    state === "suspended" && previous.state !== "suspended"
      ? tick + policy.suspensionCooldownTicks
      : previous.resumeAt;
  return reviseRecord(previous, {
    ...previous,
    state,
    stateSince: state === previous.state ? previous.stateSince : tick,
    lastEvaluatedTick: tick,
    reasonCode: "candidate-missing",
    positiveTicks: 0,
    resumeAt,
    commitment: null,
  });
}

function nextRecord(
  previous: RemotePortfolioRecord | null,
  evaluation: CandidateEvaluation,
  state: RemotePortfolioRecord["state"],
  reasonCode: RemotePortfolioReason,
  positiveTicks: number,
  tick: number,
  commitment: RemoteCapacityCommitment | null,
  resumeAt = previous?.resumeAt ?? 0,
): RemotePortfolioRecord {
  const candidate: RemotePortfolioRecord = {
    roomName: evaluation.candidate.roomName,
    donorColonyId: evaluation.candidate.donorColonyId,
    state,
    stateSince: previous?.state === state ? previous.stateSince : tick,
    lastEvaluatedTick: tick,
    revision: previous?.revision ?? 0,
    reasonCode,
    evidenceRevision: evaluation.candidate.evidenceRevision,
    expiresAt: evaluation.candidate.expiresAt,
    positiveTicks,
    resumeAt,
    forecast: evaluation.forecast,
    commitment: commitment === null ? null : { ...commitment },
  };
  return reviseRecord(previous, candidate);
}

function reviseRecord(
  previous: RemotePortfolioRecord | null,
  candidate: RemotePortfolioRecord,
): RemotePortfolioRecord {
  const withoutRevision = { ...candidate, revision: previous?.revision ?? 0 };
  if (previous !== null && JSON.stringify(previous) === JSON.stringify(withoutRevision))
    return previous;
  return deepFreeze({ ...candidate, revision: (previous?.revision ?? 0) + 1 });
}

function forecastFor(candidate: RemoteCandidateEvidence): RemoteForecast | null {
  const record = candidate.intel.record;
  let sourceCapacity = 0;
  if (record !== null) {
    for (const source of record.sources) {
      sourceCapacity = safeAdd(sourceCapacity, source.energyCapacity) ?? -1;
      if (sourceCapacity < 0) return null;
    }
  }
  const scaledRevenue = sourceCapacity * 1_000;
  if (!Number.isSafeInteger(scaledRevenue)) return null;
  const revenue = Math.floor(scaledRevenue / REMOTE_PORTFOLIO_LIMITS.sourceRegenerationTicks);
  let cost = 0;
  for (const component of REMOTE_COST_COMPONENTS) {
    cost = safeAdd(cost, candidate.costs[component]) ?? -1;
    if (cost < 0) return null;
  }
  const profit = revenue - cost;
  return Number.isSafeInteger(profit) ? deepFreeze({ revenue, cost, profit }) : null;
}

function fitRecordBound(
  records: readonly RemotePortfolioRecord[],
  revision: number,
  accounting: RemotePortfolioOwnerV2["accounting"],
): readonly RemotePortfolioRecord[] | null {
  let canonical = [...records].sort((left, right) => compare(left.roomName, right.roomName));
  const evictable = [
    ...canonical
      .filter(({ state }) => state === "candidate")
      .sort(
        (left, right) =>
          left.forecast.profit - right.forecast.profit ||
          left.stateSince - right.stateSince ||
          compare(left.roomName, right.roomName),
      ),
    ...canonical
      .filter(({ state }) => state === "retired")
      .sort(
        (left, right) =>
          left.stateSince - right.stateSince || compare(left.roomName, right.roomName),
      ),
  ];
  let evictIndex = 0;
  while (
    canonical.length > REMOTE_PORTFOLIO_LIMITS.maximumRecords ||
    encodedOwnerLength(revision, canonical, accounting) >
      REMOTE_PORTFOLIO_LIMITS.maximumOwnerCodeUnits
  ) {
    const retired = evictable[evictIndex];
    if (retired === undefined) return null;
    evictIndex += 1;
    canonical = canonical.filter(({ roomName }) => roomName !== retired.roomName);
  }
  return canonical;
}

function encodedOwnerLength(
  revision: number,
  records: readonly RemotePortfolioRecord[],
  accounting: RemotePortfolioOwnerV2["accounting"],
): number {
  return JSON.stringify({
    schemaVersion: REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION,
    revision,
    records,
    accounting,
  }).length;
}

function readyResult(
  previous: RemotePortfolioOwnerV2,
  owner: RemotePortfolioOwnerV2,
  changed: boolean,
  evaluations: readonly CandidateEvaluation[],
  accounting: RemoteAccountingResult,
): RemotePortfolioResult {
  const objectives: RemotePortfolioObjective[] = owner.records.flatMap((record) =>
    record.commitment === null ||
    (record.state !== "probing" && record.state !== "active" && record.state !== "cooldown")
      ? []
      : [
          {
            roomName: record.roomName,
            donorColonyId: record.donorColonyId,
            state: record.state,
            revision: record.revision,
            profit: record.forecast.profit,
            commitment: { ...record.commitment },
          },
        ],
  );
  const dispositions: RemotePortfolioDisposition[] = owner.records.map((record) => ({
    roomName: record.roomName,
    state: record.state,
    reason: record.reasonCode,
    profit: record.forecast.profit,
  }));
  return deepFreeze({
    status: "ready",
    changed,
    owner,
    accounting,
    objectives,
    dispositions,
    metrics: metrics(previous, owner, evaluations),
  });
}

function metrics(
  previous: RemotePortfolioOwnerV2,
  owner: RemotePortfolioOwnerV2,
  evaluations: readonly CandidateEvaluation[],
): RemotePortfolioMetrics {
  const prior = new Map(previous.records.map((record) => [record.roomName, record]));
  const total = (key: keyof RemoteCapacityCommitment): number =>
    owner.records.reduce((sum, record) => sum + (record.commitment?.[key] ?? 0), 0);
  return {
    candidates: evaluations.length,
    profitable: evaluations.filter(({ profitable }) => profitable).length,
    probing: countState(owner, "probing"),
    active: countState(owner, "active"),
    threatened: countState(owner, "threatened"),
    suspended: countState(owner, "suspended"),
    cooldown: countState(owner, "cooldown"),
    retired: countState(owner, "retired"),
    released: owner.records.filter((record) => {
      const previous = prior.get(record.roomName);
      return previous !== undefined && previous.commitment !== null && record.commitment === null;
    }).length,
    revenue: evaluations.reduce((sum, { forecast }) => sum + forecast.revenue, 0),
    cost: evaluations.reduce((sum, { forecast }) => sum + forecast.cost, 0),
    profit: evaluations.reduce((sum, { forecast }) => sum + forecast.profit, 0),
    reservedEnergy: total("energy"),
    reservedSpawnTicks: total("spawnTicks"),
    reservedCpuMilli: total("cpuMilli"),
    reservedMemoryCodeUnits: total("memoryCodeUnits"),
  };
}

function validInput(input: RemotePortfolioInput): boolean {
  return (
    nonnegative(input.tick) &&
    validCapacity(input.capacity) &&
    validPolicy(input.policy) &&
    Array.isArray(input.candidates) &&
    (input.accounting === undefined || Array.isArray(input.accounting))
  );
}

function validPolicy(policy: unknown): policy is RemotePortfolioPolicyV1 {
  if (!isRecord(policy)) return false;
  const candidate = policy as unknown as RemotePortfolioPolicyV1;
  return (
    hasSchemaVersionOne(candidate) &&
    identity(candidate.revision) &&
    positive(candidate.minimumProfitMilliPerTick) &&
    candidate.minimumProfitMilliPerTick <= REMOTE_PORTFOLIO_LIMITS.maximumRateMilliPerTick &&
    nonnegative(candidate.activeRetentionBonusMilliPerTick) &&
    candidate.activeRetentionBonusMilliPerTick <= REMOTE_PORTFOLIO_LIMITS.maximumRateMilliPerTick &&
    nonnegative(candidate.maximumThreatRisk) &&
    candidate.maximumThreatRisk <= REMOTE_PORTFOLIO_LIMITS.maximumThreatRisk &&
    positive(candidate.probingTicks) &&
    candidate.probingTicks <= REMOTE_PORTFOLIO_LIMITS.maximumDeadlineTicks &&
    positive(candidate.suspensionCooldownTicks) &&
    candidate.suspensionCooldownTicks <= REMOTE_PORTFOLIO_LIMITS.maximumDeadlineTicks &&
    positive(candidate.resumptionProbeTicks) &&
    candidate.resumptionProbeTicks <= REMOTE_PORTFOLIO_LIMITS.maximumDeadlineTicks
  );
}

function validCapacity(capacity: unknown): capacity is RemotePortfolioInput["capacity"] {
  if (!isRecord(capacity)) return false;
  const candidate = capacity as unknown as RemotePortfolioInput["capacity"];
  return (
    nonnegative(candidate.energy) &&
    nonnegative(candidate.spawnTicks) &&
    nonnegative(candidate.cpuMilli) &&
    nonnegative(candidate.memoryCodeUnits) &&
    nonnegative(candidate.activeRemotes) &&
    candidate.energy <= REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits &&
    candidate.spawnTicks <= REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits &&
    candidate.cpuMilli <= REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits &&
    candidate.memoryCodeUnits <= REMOTE_PORTFOLIO_LIMITS.maximumOwnerCodeUnits &&
    candidate.activeRemotes <= REMOTE_PORTFOLIO_LIMITS.maximumRecords
  );
}

function validCandidate(candidate: unknown): candidate is RemoteCandidateEvidence {
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, [
      "roomName",
      "donorColonyId",
      "evidenceRevision",
      "expiresAt",
      "controller",
      "donor",
      "threatRisk",
      "intel",
      "route",
      "costs",
      "commitment",
    ])
  )
    return false;
  const value = candidate as unknown as RemoteCandidateEvidence;
  if (
    !isRecord(value.costs) ||
    !isRecord(value.commitment) ||
    !isRecord(value.intel) ||
    !isRecord(value.route)
  ) {
    return false;
  }
  if (
    !roomName(value.intel.roomName) ||
    !["current", "fresh", "stale", "expired", "unknown"].includes(value.intel.freshness) ||
    !["complete", "partial", "unknown"].includes(value.intel.quality) ||
    !["ready", "stale-route", "unsafe-route", "no-route", "deferred", "invalid"].includes(
      value.route.status,
    )
  ) {
    return false;
  }
  const intelRecord: unknown = value.intel.record;
  if (
    intelRecord !== null &&
    (!isRecord(intelRecord) ||
      typeof intelRecord.complete !== "boolean" ||
      !Array.isArray(intelRecord.sources) ||
      intelRecord.sources.length > REMOTE_PORTFOLIO_LIMITS.maximumSourcesPerRemote ||
      intelRecord.sources.some(
        (source) =>
          !isRecord(source) ||
          !positive(source.energyCapacity) ||
          source.energyCapacity > REMOTE_PORTFOLIO_LIMITS.maximumSourceEnergyCapacity,
      ))
  ) {
    return false;
  }
  if (value.route.plan !== null && !isRecord(value.route.plan)) return false;
  if (
    value.route.status === "ready" &&
    (value.route.plan === null ||
      !roomName(value.route.plan.originRoomName) ||
      !roomName(value.route.plan.destinationRoomName) ||
      !nonnegative(value.route.plan.risk))
  ) {
    return false;
  }
  return (
    roomName(value.roomName) &&
    roomName(value.donorColonyId) &&
    value.roomName !== value.donorColonyId &&
    identity(value.evidenceRevision) &&
    nonnegative(value.expiresAt) &&
    ["available", "self-reserved", "blocked", "unknown"].includes(value.controller) &&
    ["healthy", "brownout", "threatened", "unknown"].includes(value.donor) &&
    nonnegative(value.threatRisk) &&
    value.threatRisk <= REMOTE_PORTFOLIO_LIMITS.maximumThreatRisk &&
    REMOTE_COST_COMPONENTS.every(
      (component) =>
        nonnegative(value.costs[component]) &&
        value.costs[component] <= REMOTE_PORTFOLIO_LIMITS.maximumRateMilliPerTick,
    ) &&
    Object.keys(value.costs).length === REMOTE_COST_COMPONENTS.length &&
    validCommitment(value.commitment)
  );
}

function validCommitment(value: unknown): value is RemoteCapacityCommitment {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["energy", "spawnTicks", "cpuMilli", "memoryCodeUnits"])
  )
    return false;
  const candidate = value as unknown as RemoteCapacityCommitment;
  return (
    nonnegative(candidate.energy) &&
    nonnegative(candidate.spawnTicks) &&
    nonnegative(candidate.cpuMilli) &&
    nonnegative(candidate.memoryCodeUnits) &&
    candidate.energy <= REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits &&
    candidate.spawnTicks <= REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits &&
    candidate.cpuMilli <= REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits &&
    candidate.memoryCodeUnits <= REMOTE_PORTFOLIO_LIMITS.maximumOwnerCodeUnits
  );
}

function sameRecords(left: RemotePortfolioOwnerV2, right: RemotePortfolioOwnerV2): boolean {
  return remotePortfolioOwnerEquals(left, { ...right, revision: left.revision });
}
function countState(owner: RemotePortfolioOwnerV2, state: RemotePortfolioRecord["state"]): number {
  return owner.records.filter((record) => record.state === state).length;
}
function safeAdd(left: number, right: number): number | null {
  const value = left + right;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= REMOTE_PORTFOLIO_LIMITS.maximumIdentityCodeUnits &&
    value === value.trim()
  );
}
function roomName(value: unknown): value is string {
  return typeof value === "string" && /^(W|E)\d+(N|S)\d+$/u.test(value) && value.length <= 16;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function hasSchemaVersionOne(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly schemaVersion?: unknown }).schemaVersion === 1
  );
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
function preservedResult(
  status: Exclude<
    RemotePortfolioResult["status"],
    "ready" | "owner-malformed" | "owner-future-schema"
  >,
): RemotePortfolioResult {
  return emptyResult(status);
}
function emptyResult(
  status: Exclude<RemotePortfolioResult["status"], "ready">,
): RemotePortfolioResult {
  return deepFreeze({
    status,
    changed: false,
    owner: null,
    accounting: emptyAccounting(status),
    objectives: [],
    dispositions: [],
    metrics: emptyMetrics(),
  });
}
function emptyAccounting(
  status: Exclude<RemotePortfolioResult["status"], "ready">,
): RemoteAccountingResult {
  return {
    status: status === "limit-exceeded" ? "limit-exceeded" : "invalid-input",
    changed: false,
    records: [],
    summaries: [],
    metrics: {
      observed: 0,
      tracked: 0,
      warmingUp: 0,
      profitable: 0,
      marginal: 0,
      lossMaking: 0,
      stale: 0,
      incomplete: 0,
      revenueMilli: 0,
      costMilli: 0,
      profitMilli: 0,
      harvestedEnergy: 0,
      deliveredEnergy: 0,
      downtimeTicks: 0,
    },
  };
}
function emptyMetrics(): RemotePortfolioMetrics {
  return {
    candidates: 0,
    profitable: 0,
    probing: 0,
    active: 0,
    threatened: 0,
    suspended: 0,
    cooldown: 0,
    retired: 0,
    released: 0,
    revenue: 0,
    cost: 0,
    profit: 0,
    reservedEnergy: 0,
    reservedSpawnTicks: 0,
    reservedCpuMilli: 0,
    reservedMemoryCodeUnits: 0,
  };
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
