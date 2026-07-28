import {
  REMOTE_ACCOUNTING_LIMITS,
  type RemoteAccountingMetrics,
  type RemoteAccountingObservation,
  type RemoteAccountingPolicyV1,
  type RemoteAccountingRecordV1,
  type RemoteAccountingResult,
  type RemoteAccountingSampleV1,
  type RemoteProfitabilitySummary,
  type RemoteRealizedCosts,
} from "./accounting-contracts";

interface RemoteAccountingInput {
  readonly tick: number;
  readonly previous: readonly RemoteAccountingRecordV1[];
  readonly observations: readonly RemoteAccountingObservation[];
  readonly policy: RemoteAccountingPolicyV1;
  /** Accounting rings for non-evictable portfolio lifecycle records. */
  readonly protectedRoomNames?: readonly string[];
}

/** Parses only canonical portfolio-owned accounting records. */
export function parseRemoteAccountingRecords(
  value: unknown,
): readonly RemoteAccountingRecordV1[] | null {
  return normalizePrevious(value);
}

/**
 * Pure reducer owned by RemotePortfolio. Inputs are settled detached receipts; this function neither
 * observes the world nor authorizes gameplay.
 */
export function reduceRemoteAccounting(input: RemoteAccountingInput): RemoteAccountingResult {
  const raw: unknown = input;
  if (!isRecord(raw)) return failed("invalid-input", [], 0, undefined);
  if (!validPolicy(input.policy)) return failed("invalid-input", [], 0, undefined);
  if (!nonnegative(input.tick)) return failed("invalid-input", [], 0, input.policy);
  const previous = normalizePrevious(input.previous);
  if (previous === null) return failed("invalid-input", [], input.tick, input.policy);
  if (previous.some((record) => latestTick(record) > input.tick)) {
    return failed("invalid-input", previous, input.tick, input.policy);
  }
  if (!Array.isArray(input.observations)) {
    return failed("invalid-input", previous, input.tick, input.policy);
  }
  if (input.observations.length > REMOTE_ACCOUNTING_LIMITS.maximumObservationsPerTick) {
    return failed("limit-exceeded", previous, input.tick, input.policy);
  }
  const observations = normalizeObservations(input.observations, input.tick);
  const protectedRooms = normalizeProtectedRooms(input.protectedRoomNames ?? []);
  if (observations === null || protectedRooms === null) {
    return failed("invalid-input", previous, input.tick, input.policy);
  }

  const byRoom = new Map(previous.map((record) => [record.roomName, record]));
  for (const observation of observations) {
    const sample = sampleFor(observation);
    const prior = byRoom.get(observation.roomName);
    if (prior !== undefined && prior.donorColonyId !== observation.donorColonyId) {
      return failed("invalid-input", previous, input.tick, input.policy);
    }
    const samples = prior?.samples ?? [];
    const sameTick = samples.find(([tick]) => tick === observation.observedAt);
    if (sameTick !== undefined) {
      if (JSON.stringify(sameTick) !== JSON.stringify(sample)) {
        return failed("invalid-input", previous, input.tick, input.policy);
      }
      continue;
    }
    const retained = [...samples, sample]
      .filter(([tick]) => tick >= input.tick - input.policy.windowTicks + 1)
      .sort((left, right) => left[0] - right[0])
      .slice(-input.policy.maximumSamplesPerRemote);
    byRoom.set(
      observation.roomName,
      freeze({
        roomName: observation.roomName,
        donorColonyId: observation.donorColonyId,
        samples: retained,
      }),
    );
  }

  let records = [...byRoom.values()].sort((left, right) => compare(left.roomName, right.roomName));
  if (records.length > REMOTE_ACCOUNTING_LIMITS.maximumRecords) {
    const observedRooms = new Set(observations.map(({ roomName }) => roomName));
    const evictable = records
      .filter(({ roomName }) => !observedRooms.has(roomName) && !protectedRooms.has(roomName))
      .sort(
        (left, right) =>
          latestTick(left) - latestTick(right) || compare(left.roomName, right.roomName),
      );
    for (const record of evictable) {
      if (records.length <= REMOTE_ACCOUNTING_LIMITS.maximumRecords) break;
      records = records.filter(({ roomName }) => roomName !== record.roomName);
    }
  }
  if (records.length > REMOTE_ACCOUNTING_LIMITS.maximumRecords) {
    return failed("limit-exceeded", previous, input.tick, input.policy);
  }

  const summaries = summarize(records, input.tick, input.policy);
  if (summaries === null) return failed("invalid-input", previous, input.tick, input.policy);
  const resultMetrics = metrics(observations.length, summaries);
  if (resultMetrics === null) return failed("invalid-input", previous, input.tick, input.policy);
  return deepFreeze({
    status: "ready",
    changed: JSON.stringify(previous) !== JSON.stringify(records),
    records,
    summaries,
    metrics: resultMetrics,
  });
}

function summarize(
  records: readonly RemoteAccountingRecordV1[],
  tick: number,
  policy: RemoteAccountingPolicyV1,
): readonly RemoteProfitabilitySummary[] | null {
  const summaries: RemoteProfitabilitySummary[] = [];
  for (const record of records) {
    if (record.samples.length === 0) continue;
    const samples = record.samples.filter(
      ([observedAt]) => observedAt >= tick - policy.windowTicks + 1,
    );
    const retained =
      samples.length === 0
        ? [record.samples[record.samples.length - 1] as RemoteAccountingSampleV1]
        : samples;
    const first = retained[0] as RemoteAccountingSampleV1;
    const latest = retained[retained.length - 1] as RemoteAccountingSampleV1;
    const span = Math.max(1, latest[0] - first[0] + 1);
    const completeTicks = total(retained.map((sample) => sample[1]));
    const confidenceBasisPoints = Math.floor((completeTicks * 10_000) / span);
    const harvestedEnergy = total(retained.map((sample) => sample[2]));
    const deliveredEnergy = total(retained.map((sample) => sample[3]));
    const downtimeTicks = total(retained.map((sample) => sample[12]));
    const costs = realizedCosts(retained, policy);
    if (costs === null) return null;
    const revenueMilli = multiply(deliveredEnergy, 1_000);
    if (revenueMilli === null) return null;
    const profitMilli = subtract(revenueMilli, costs.totalMilli);
    if (profitMilli === null) return null;
    const profitMilliPerTick = Math.floor(profitMilli / span);
    const forecastProfitMilliPerTick = latest[14];
    const forecastVarianceMilliPerTick = subtract(profitMilliPerTick, forecastProfitMilliPerTick);
    if (forecastVarianceMilliPerTick === null) return null;
    const expectedRevenueMilli = total(retained.map((sample) => sample[13]));
    const harvestedMilli = multiply(harvestedEnergy, 1_000);
    if (harvestedMilli === null) return null;
    const utilizationBasisPoints =
      expectedRevenueMilli === 0
        ? 0
        : harvestedMilli >= expectedRevenueMilli
          ? 10_000
          : Math.floor((harvestedMilli * 10_000) / expectedRevenueMilli);
    const reason =
      tick - latest[0] > policy.staleAfterTicks
        ? "stale"
        : latest[1] === 0 || confidenceBasisPoints < policy.minimumConfidenceBasisPoints
          ? "incomplete"
          : completeTicks < policy.minimumCompleteTicks
            ? "warming-up"
            : profitMilliPerTick < policy.minimumProfitMilliPerTick
              ? "loss-making"
              : profitMilliPerTick <= policy.marginalProfitMilliPerTick
                ? "marginal"
                : "profitable";
    summaries.push(
      deepFreeze({
        roomName: record.roomName,
        donorColonyId: record.donorColonyId,
        windowStartTick: first[0],
        windowEndTick: latest[0],
        sampleTicks: retained.length,
        completeTicks,
        confidenceBasisPoints,
        harvestedEnergy,
        deliveredEnergy,
        downtimeTicks,
        forecastProfitMilliPerTick,
        costs,
        revenueMilli,
        profitMilli,
        profitMilliPerTick,
        forecastVarianceMilliPerTick,
        utilizationBasisPoints,
        reason,
      }),
    );
  }
  return summaries;
}

function realizedCosts(
  samples: readonly RemoteAccountingSampleV1[],
  policy: RemoteAccountingPolicyV1,
): RemoteRealizedCosts | null {
  const sampleTotal = (index: number): number | null =>
    checkedTotal(samples.map((sample) => sample[index] as number));
  const energyCost = (index: 4 | 7 | 8 | 9 | 11): number | null => {
    const value = sampleTotal(index);
    return value === null ? null : multiply(value, 1_000);
  };
  const pricedCost = (index: 5 | 6 | 10, price: number): number | null => {
    const value = sampleTotal(index);
    return value === null ? null : multiply(value, price);
  };
  const spawnEnergyMilli = energyCost(4);
  const spawnTimeMilli = pricedCost(5, policy.spawnTimeCostMilliEnergyPerTick);
  const travelMilli = pricedCost(6, policy.travelCostMilliEnergyPerTick);
  const reservationMilli = energyCost(7);
  const constructionMilli = energyCost(8);
  const repairMilli = energyCost(9);
  const cpuMilli = pricedCost(10, policy.cpuCostMilliEnergyPerMilliCpu);
  const creepLossMilli = energyCost(11);
  const downtimeCosts = samples.map((sample) => multiply(sample[12], sample[13]));
  if (downtimeCosts.some((value) => value === null)) return null;
  const downtimeMilli = checkedTotal(downtimeCosts as number[]);
  const values = [
    spawnEnergyMilli,
    spawnTimeMilli,
    travelMilli,
    reservationMilli,
    constructionMilli,
    repairMilli,
    cpuMilli,
    creepLossMilli,
    downtimeMilli,
  ];
  if (values.some((value) => value === null)) return null;
  const costs = values as number[];
  const totalMilli = checkedTotal(costs);
  if (totalMilli === null) return null;
  return deepFreeze({
    spawnEnergyMilli: costs[0] as number,
    spawnTimeMilli: costs[1] as number,
    travelMilli: costs[2] as number,
    reservationMilli: costs[3] as number,
    constructionMilli: costs[4] as number,
    repairMilli: costs[5] as number,
    cpuMilli: costs[6] as number,
    creepLossMilli: costs[7] as number,
    downtimeMilli: costs[8] as number,
    totalMilli,
  });
}

function metrics(
  observed: number,
  summaries: readonly RemoteProfitabilitySummary[],
): RemoteAccountingMetrics | null {
  const count = (reason: RemoteProfitabilitySummary["reason"]): number =>
    summaries.filter((summary) => summary.reason === reason).length;
  const revenueMilli = checkedTotal(summaries.map(({ revenueMilli: value }) => value));
  const costMilli = checkedTotal(summaries.map(({ costs }) => costs.totalMilli));
  const profitMilli = checkedSignedTotal(summaries.map(({ profitMilli: value }) => value));
  const harvestedEnergy = checkedTotal(summaries.map(({ harvestedEnergy: value }) => value));
  const deliveredEnergy = checkedTotal(summaries.map(({ deliveredEnergy: value }) => value));
  const downtimeTicks = checkedTotal(summaries.map(({ downtimeTicks: value }) => value));
  if (
    revenueMilli === null ||
    costMilli === null ||
    profitMilli === null ||
    harvestedEnergy === null ||
    deliveredEnergy === null ||
    downtimeTicks === null
  )
    return null;
  return {
    observed,
    tracked: summaries.length,
    warmingUp: count("warming-up"),
    profitable: count("profitable"),
    marginal: count("marginal"),
    lossMaking: count("loss-making"),
    stale: count("stale"),
    incomplete: count("incomplete"),
    revenueMilli,
    costMilli,
    profitMilli,
    harvestedEnergy,
    deliveredEnergy,
    downtimeTicks,
  };
}

function normalizeObservations(
  values: readonly RemoteAccountingObservation[],
  tick: number,
): readonly RemoteAccountingObservation[] | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (!validObservation(value, tick) || seen.has(value.roomName)) return null;
    seen.add(value.roomName);
  }
  return [...values].sort((left, right) => compare(left.roomName, right.roomName));
}

function normalizeProtectedRooms(values: readonly string[]): ReadonlySet<string> | null {
  if (!Array.isArray(values) || values.length > REMOTE_ACCOUNTING_LIMITS.maximumRecords)
    return null;
  const rooms = new Set<string>();
  for (const value of values) {
    if (!roomName(value) || rooms.has(value)) return null;
    rooms.add(value);
  }
  return rooms;
}

function normalizePrevious(value: unknown): readonly RemoteAccountingRecordV1[] | null {
  if (!Array.isArray(value) || value.length > REMOTE_ACCOUNTING_LIMITS.maximumRecords) return null;
  const values = value as readonly RemoteAccountingRecordV1[];
  const result: RemoteAccountingRecordV1[] = [];
  let previousRoom = "";
  for (const value of values) {
    if (
      !isRecord(value) ||
      !roomName(value.roomName) ||
      !identity(value.donorColonyId) ||
      !Array.isArray(value.samples) ||
      value.samples.length === 0 ||
      value.samples.length > REMOTE_ACCOUNTING_LIMITS.maximumSamplesPerRemote ||
      (previousRoom !== "" && compare(previousRoom, value.roomName) >= 0)
    )
      return null;
    const samples: RemoteAccountingSampleV1[] = [];
    let priorTick = -1;
    for (const sample of value.samples) {
      if (!validSample(sample) || sample[0] <= priorTick) return null;
      samples.push([...sample] as unknown as RemoteAccountingSampleV1);
      priorTick = sample[0];
    }
    result.push(freeze({ roomName: value.roomName, donorColonyId: value.donorColonyId, samples }));
    previousRoom = value.roomName;
  }
  return result;
}

function validObservation(value: unknown, tick: number): value is RemoteAccountingObservation {
  if (!isRecord(value)) return false;
  const fields = [
    value.harvestedEnergy,
    value.deliveredEnergy,
    value.spawnEnergy,
    value.spawnTicks,
    value.travelTicks,
    value.reservationEnergy,
    value.constructionEnergy,
    value.repairEnergy,
    value.cpuMilli,
    value.creepLossEnergy,
    value.downtimeTicks,
    value.forecastRevenueMilliPerTick,
  ];
  return (
    roomName(value.roomName) &&
    identity(value.donorColonyId) &&
    value.observedAt === tick &&
    (value.quality === "complete" || value.quality === "partial") &&
    fields.every(boundedValue) &&
    signedBoundedValue(value.forecastProfitMilliPerTick)
  );
}

function validPolicy(value: unknown): value is RemoteAccountingPolicyV1 {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    identity(value.revision) &&
    positive(value.windowTicks) &&
    value.windowTicks <= REMOTE_ACCOUNTING_LIMITS.maximumWindowTicks &&
    positive(value.maximumSamplesPerRemote) &&
    value.maximumSamplesPerRemote <= REMOTE_ACCOUNTING_LIMITS.maximumSamplesPerRemote &&
    positive(value.minimumCompleteTicks) &&
    value.minimumCompleteTicks <= value.maximumSamplesPerRemote &&
    nonnegative(value.minimumConfidenceBasisPoints) &&
    value.minimumConfidenceBasisPoints <= 10_000 &&
    nonnegative(value.staleAfterTicks) &&
    value.staleAfterTicks <= value.windowTicks &&
    signedBoundedValue(value.minimumProfitMilliPerTick) &&
    signedBoundedValue(value.marginalProfitMilliPerTick) &&
    value.marginalProfitMilliPerTick >= value.minimumProfitMilliPerTick &&
    boundedValue(value.spawnTimeCostMilliEnergyPerTick) &&
    boundedValue(value.travelCostMilliEnergyPerTick) &&
    boundedValue(value.cpuCostMilliEnergyPerMilliCpu)
  );
}

function sampleFor(value: RemoteAccountingObservation): RemoteAccountingSampleV1 {
  return freeze([
    value.observedAt,
    value.quality === "complete" ? 1 : 0,
    value.harvestedEnergy,
    value.deliveredEnergy,
    value.spawnEnergy,
    value.spawnTicks,
    value.travelTicks,
    value.reservationEnergy,
    value.constructionEnergy,
    value.repairEnergy,
    value.cpuMilli,
    value.creepLossEnergy,
    value.downtimeTicks,
    value.forecastRevenueMilliPerTick,
    value.forecastProfitMilliPerTick,
  ]);
}

function validSample(value: unknown): value is RemoteAccountingSampleV1 {
  return (
    Array.isArray(value) &&
    value.length === 15 &&
    nonnegative(value[0]) &&
    (value[1] === 0 || value[1] === 1) &&
    value.slice(2, 14).every(boundedValue) &&
    signedBoundedValue(value[14])
  );
}

function failed(
  status: "invalid-input" | "limit-exceeded",
  records: readonly RemoteAccountingRecordV1[],
  tick: number,
  policy: RemoteAccountingPolicyV1 | undefined,
): RemoteAccountingResult {
  const summaries = policy === undefined ? [] : (summarize(records, tick, policy) ?? []);
  return deepFreeze({
    status,
    changed: false,
    records,
    summaries,
    metrics: metrics(0, summaries) ?? emptyMetrics(),
  });
}

function latestTick(record: RemoteAccountingRecordV1): number {
  return record.samples[record.samples.length - 1]?.[0] ?? -1;
}
function roomName(value: unknown): value is string {
  return typeof value === "string" && /^(W|E)\d+(N|S)\d+$/u.test(value) && value.length <= 16;
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= REMOTE_ACCOUNTING_LIMITS.maximumIdentityCodeUnits &&
    value === value.trim()
  );
}
function boundedValue(value: unknown): value is number {
  return nonnegative(value) && value <= REMOTE_ACCOUNTING_LIMITS.maximumValuePerTick;
}
function signedBoundedValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= REMOTE_ACCOUNTING_LIMITS.maximumValuePerTick
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function multiply(left: number, right: number): number | null {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : null;
}
function subtract(left: number, right: number): number | null {
  const value = left - right;
  return Number.isSafeInteger(value) ? value : null;
}
function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
function checkedTotal(values: readonly number[]): number | null {
  let sum = 0;
  for (const value of values) {
    const next = sum + value;
    if (!Number.isSafeInteger(next) || next < 0) return null;
    sum = next;
  }
  return sum;
}
function checkedSignedTotal(values: readonly number[]): number | null {
  let sum = 0;
  for (const value of values) {
    const next = sum + value;
    if (!Number.isSafeInteger(next)) return null;
    sum = next;
  }
  return sum;
}
function emptyMetrics(): RemoteAccountingMetrics {
  return {
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
  };
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function freeze<T>(value: T): T {
  return Object.freeze(value);
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
