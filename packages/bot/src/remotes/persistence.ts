import {
  REMOTE_PORTFOLIO_LIMITS,
  REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION,
  REMOTE_PORTFOLIO_REASONS,
  REMOTE_PORTFOLIO_STATES,
  type RemoteCapacityCommitment,
  type RemoteForecast,
  type RemotePortfolioOwnerV1,
  type RemotePortfolioRecord,
} from "./contracts";

export type RemotePortfolioOwnerStatus = "initialized" | "ready" | "malformed" | "future-schema";

export interface RemotePortfolioOwnerResolution {
  readonly status: RemotePortfolioOwnerStatus;
  readonly owner: RemotePortfolioOwnerV1 | null;
}

const OWNER_KEYS = ["schemaVersion", "revision", "records"] as const;
const RECORD_KEYS = [
  "roomName",
  "donorColonyId",
  "state",
  "stateSince",
  "lastEvaluatedTick",
  "revision",
  "reasonCode",
  "evidenceRevision",
  "expiresAt",
  "positiveTicks",
  "resumeAt",
  "forecast",
  "commitment",
] as const;
const FORECAST_KEYS = ["revenue", "cost", "profit"] as const;
const COMMITMENT_KEYS = ["energy", "spawnTicks", "cpuMilli", "memoryCodeUnits"] as const;

export function resolveRemotePortfolioOwner(value: unknown): RemotePortfolioOwnerResolution {
  try {
    if (!isRecord(value)) return freeze({ status: "malformed", owner: null });
    if (Object.keys(value).length === 0) {
      return freeze({ status: "initialized", owner: emptyRemotePortfolioOwner() });
    }
    if (
      nonnegative(value.schemaVersion) &&
      value.schemaVersion > REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION
    ) {
      return freeze({ status: "future-schema", owner: null });
    }
    const owner = parseOwner(value);
    return owner === null
      ? freeze({ status: "malformed", owner: null })
      : freeze({ status: "ready", owner });
  } catch {
    return freeze({ status: "malformed", owner: null });
  }
}

export function emptyRemotePortfolioOwner(): RemotePortfolioOwnerV1 {
  return deepFreeze({
    schemaVersion: REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION,
    revision: 0,
    records: [],
  });
}

export function canonicalRemotePortfolioOwner(
  revision: number,
  records: readonly RemotePortfolioRecord[],
): RemotePortfolioOwnerV1 {
  return deepFreeze({
    schemaVersion: REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION,
    revision,
    records: [...records].sort((left, right) => compare(left.roomName, right.roomName)),
  });
}

export function remotePortfolioOwnerEquals(
  left: RemotePortfolioOwnerV1,
  right: RemotePortfolioOwnerV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseOwner(value: Readonly<Record<string, unknown>>): RemotePortfolioOwnerV1 | null {
  if (
    !hasExactKeys(value, OWNER_KEYS) ||
    value.schemaVersion !== REMOTE_PORTFOLIO_OWNER_SCHEMA_VERSION ||
    !nonnegative(value.revision) ||
    !Array.isArray(value.records) ||
    value.records.length > REMOTE_PORTFOLIO_LIMITS.maximumRecords
  ) {
    return null;
  }
  const records: RemotePortfolioRecord[] = [];
  for (const candidate of value.records) {
    const record = parseRecord(candidate);
    if (record === null) return null;
    records.push(record);
  }
  if (!strictlySorted(records.map(({ roomName }) => roomName))) return null;
  return canonicalRemotePortfolioOwner(value.revision, records);
}

function parseRecord(value: unknown): RemotePortfolioRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) return null;
  const forecast = parseForecast(value.forecast);
  const commitment = value.commitment === null ? null : parseCommitment(value.commitment);
  if (
    !identity(value.roomName) ||
    !identity(value.donorColonyId) ||
    typeof value.state !== "string" ||
    !REMOTE_PORTFOLIO_STATES.includes(value.state as RemotePortfolioRecord["state"]) ||
    !nonnegative(value.stateSince) ||
    !nonnegative(value.lastEvaluatedTick) ||
    value.lastEvaluatedTick < value.stateSince ||
    !nonnegative(value.revision) ||
    typeof value.reasonCode !== "string" ||
    !REMOTE_PORTFOLIO_REASONS.includes(value.reasonCode as RemotePortfolioRecord["reasonCode"]) ||
    !identity(value.evidenceRevision) ||
    !nonnegative(value.expiresAt) ||
    !nonnegative(value.positiveTicks) ||
    !nonnegative(value.resumeAt) ||
    forecast === null ||
    (value.commitment !== null && commitment === null)
  ) {
    return null;
  }
  const state = value.state as RemotePortfolioRecord["state"];
  const funded = state === "probing" || state === "active" || state === "cooldown";
  if (funded !== (commitment !== null)) return null;
  return deepFreeze({
    roomName: value.roomName,
    donorColonyId: value.donorColonyId,
    state,
    stateSince: value.stateSince,
    lastEvaluatedTick: value.lastEvaluatedTick,
    revision: value.revision,
    reasonCode: value.reasonCode as RemotePortfolioRecord["reasonCode"],
    evidenceRevision: value.evidenceRevision,
    expiresAt: value.expiresAt,
    positiveTicks: value.positiveTicks,
    resumeAt: value.resumeAt,
    forecast,
    commitment,
  });
}

function parseForecast(value: unknown): RemoteForecast | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, FORECAST_KEYS) ||
    !nonnegative(value.revenue) ||
    !nonnegative(value.cost) ||
    value.revenue > REMOTE_PORTFOLIO_LIMITS.maximumRateMilliPerTick * 8 ||
    value.cost > REMOTE_PORTFOLIO_LIMITS.maximumRateMilliPerTick * 9 ||
    !signedInteger(value.profit) ||
    value.revenue - value.cost !== value.profit
  ) {
    return null;
  }
  return deepFreeze({ revenue: value.revenue, cost: value.cost, profit: value.profit });
}

function parseCommitment(value: unknown): RemoteCapacityCommitment | null {
  if (!isRecord(value) || !hasExactKeys(value, COMMITMENT_KEYS)) return null;
  if (
    !nonnegative(value.energy) ||
    !nonnegative(value.spawnTicks) ||
    !nonnegative(value.cpuMilli) ||
    !nonnegative(value.memoryCodeUnits) ||
    value.energy > REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits ||
    value.spawnTicks > REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits ||
    value.cpuMilli > REMOTE_PORTFOLIO_LIMITS.maximumCapacityUnits ||
    value.memoryCodeUnits > REMOTE_PORTFOLIO_LIMITS.maximumOwnerCodeUnits
  ) {
    return null;
  }
  return deepFreeze({
    energy: value.energy,
    spawnTicks: value.spawnTicks,
    cpuMilli: value.cpuMilli,
    memoryCodeUnits: value.memoryCodeUnits,
  });
}

function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= REMOTE_PORTFOLIO_LIMITS.maximumIdentityCodeUnits &&
    value === value.trim()
  );
}
function signedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function nonnegative(value: unknown): value is number {
  return signedInteger(value) && value >= 0;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function strictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1] ?? "", value) < 0);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function freeze<T>(value: T): T {
  return Object.freeze(value);
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
