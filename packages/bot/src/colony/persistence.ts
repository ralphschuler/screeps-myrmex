import {
  BUDGET_REASON_CODES,
  BUDGET_CATEGORIES,
  COLONY_OWNER_SCHEMA_VERSION,
  COLONY_STATES,
  COLONY_TRANSITION_REASONS,
  LEDGER_ENTRY_STATUSES,
  MAX_ACTIVE_RESERVATIONS,
  MAX_BUDGET_ISSUER_CODE_UNITS,
  MAX_COLONIES,
  MAX_LEDGER_ENTRIES,
  MAX_RESERVATION_ID_CODE_UNITS,
  MAX_SPAWN_INTERVAL_TICKS,
  type BudgetConsumption,
  type BudgetGrant,
  type BudgetRequest,
  type ColoniesOwnerV1,
  type ColonyRecord,
  type ElasticBudgetClaim,
  type LedgerEntry,
  type SpawnIntervalClaim,
} from "./contracts";
import { formatReservationId } from "./reservation-id";

export type ColoniesOwnerStatus = "initialized" | "ready" | "malformed" | "future-schema";

export interface ColoniesOwnerResolution {
  readonly status: ColoniesOwnerStatus;
  readonly owner: ColoniesOwnerV1 | null;
}

const OWNER_KEYS = ["schemaVersion", "revision", "colonies", "ledger"] as const;
const COLONY_KEYS = [
  "roomName",
  "state",
  "stateSince",
  "revision",
  "policyRevision",
  "reasonCode",
] as const;
const ENTRY_KEYS = [
  "reservationId",
  "colonyId",
  "category",
  "issuer",
  "revision",
  "request",
  "grant",
  "consumed",
  "createdAt",
  "updatedAt",
  "status",
  "reasonCode",
] as const;
const REQUEST_KEYS = [
  "colonyId",
  "category",
  "issuer",
  "revision",
  "expiresAt",
  "energy",
  "cpu",
  "spawn",
] as const;
const CLAIM_KEYS = ["minimum", "desired"] as const;
const INTERVAL_KEYS = ["spawnId", "startTick", "endTick"] as const;
const GRANT_KEYS = ["energy", "cpu", "spawn"] as const;
const CONSUMPTION_KEYS = ["energy", "cpu", "spawn"] as const;

export function resolveColoniesOwner(value: unknown): ColoniesOwnerResolution {
  try {
    if (!isRecord(value)) {
      return freeze({ status: "malformed", owner: null });
    }
    if (Object.keys(value).length === 0) {
      return freeze({ status: "initialized", owner: emptyColoniesOwner() });
    }

    const declaredVersion = value.schemaVersion;
    if (isSafeInteger(declaredVersion) && declaredVersion > COLONY_OWNER_SCHEMA_VERSION) {
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

export function emptyColoniesOwner(): ColoniesOwnerV1 {
  return deepFreeze({
    schemaVersion: COLONY_OWNER_SCHEMA_VERSION,
    revision: 0,
    colonies: [],
    ledger: [],
  });
}

export function canonicalColoniesOwner(
  revision: number,
  colonies: readonly ColonyRecord[],
  ledger: readonly LedgerEntry[],
): ColoniesOwnerV1 {
  return deepFreeze({
    schemaVersion: COLONY_OWNER_SCHEMA_VERSION,
    revision,
    colonies: [...colonies].sort((left, right) => compareStrings(left.roomName, right.roomName)),
    ledger: [...ledger].sort(compareLedgerEntries),
  });
}

export function coloniesOwnerEquals(left: ColoniesOwnerV1, right: ColoniesOwnerV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function ledgerIssuerKey(value: {
  readonly colonyId: string;
  readonly category: string;
  readonly issuer: string;
}): string {
  return `${value.colonyId}\u0000${value.category}\u0000${value.issuer}`;
}

function parseOwner(value: Readonly<Record<string, unknown>>): ColoniesOwnerV1 | null {
  if (
    !hasExactKeys(value, OWNER_KEYS) ||
    value.schemaVersion !== COLONY_OWNER_SCHEMA_VERSION ||
    !isSafeInteger(value.revision) ||
    !isDataArray(value.colonies) ||
    !isDataArray(value.ledger) ||
    value.colonies.length > MAX_COLONIES ||
    value.ledger.length > MAX_LEDGER_ENTRIES
  ) {
    return null;
  }

  const colonies: ColonyRecord[] = [];
  for (const candidate of value.colonies) {
    const colony = parseColony(candidate);
    if (colony === null) {
      return null;
    }
    colonies.push(colony);
  }
  if (!isStrictlySorted(colonies, (colony) => colony.roomName)) {
    return null;
  }

  const colonyStates = new Map(colonies.map((colony) => [colony.roomName, colony.state]));
  const ledger: LedgerEntry[] = [];
  const reservationIds = new Set<string>();
  let active = 0;
  for (const candidate of value.ledger) {
    const entry = parseLedgerEntry(candidate);
    if (
      entry === null ||
      !colonyStates.has(entry.colonyId) ||
      reservationIds.has(entry.reservationId)
    ) {
      return null;
    }
    reservationIds.add(entry.reservationId);
    if (entry.status === "active") {
      active += 1;
      if (colonyStates.get(entry.colonyId) === "lost") {
        return null;
      }
    }
    ledger.push(entry);
  }
  if (
    active > MAX_ACTIVE_RESERVATIONS ||
    !isStrictlySorted(ledger, (entry) => ledgerIssuerKey(entry))
  ) {
    return null;
  }

  return canonicalColoniesOwner(value.revision, colonies, ledger);
}

function parseColony(value: unknown): ColonyRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, COLONY_KEYS)) {
    return null;
  }
  if (
    !isIdentifier(value.roomName, 64) ||
    typeof value.state !== "string" ||
    !COLONY_STATES.includes(value.state as ColonyRecord["state"]) ||
    !isSafeInteger(value.stateSince) ||
    !isSafeInteger(value.revision) ||
    !isIdentifier(value.policyRevision, 128) ||
    typeof value.reasonCode !== "string" ||
    !COLONY_TRANSITION_REASONS.includes(value.reasonCode as ColonyRecord["reasonCode"])
  ) {
    return null;
  }
  return {
    roomName: value.roomName,
    state: value.state as ColonyRecord["state"],
    stateSince: value.stateSince,
    revision: value.revision,
    policyRevision: value.policyRevision,
    reasonCode: value.reasonCode as ColonyRecord["reasonCode"],
  };
}

function parseLedgerEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) {
    return null;
  }
  const request = parseRequest(value.request);
  const grant = parseGrant(value.grant);
  const consumed = parseConsumption(value.consumed);
  if (
    request === null ||
    grant === null ||
    consumed === null ||
    !isIdentifier(value.reservationId, MAX_RESERVATION_ID_CODE_UNITS) ||
    !isIdentifier(value.colonyId, 64) ||
    typeof value.category !== "string" ||
    !BUDGET_CATEGORIES.includes(value.category as LedgerEntry["category"]) ||
    !isIdentifier(value.issuer, MAX_BUDGET_ISSUER_CODE_UNITS) ||
    !isSafeInteger(value.revision) ||
    !isSafeInteger(value.createdAt) ||
    !isSafeInteger(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    typeof value.status !== "string" ||
    !LEDGER_ENTRY_STATUSES.includes(value.status as LedgerEntry["status"]) ||
    typeof value.reasonCode !== "string" ||
    !BUDGET_REASON_CODES.includes(value.reasonCode as LedgerEntry["reasonCode"]) ||
    request.colonyId !== value.colonyId ||
    request.category !== value.category ||
    request.issuer !== value.issuer ||
    request.revision !== value.revision ||
    value.reservationId !== formatReservationId(request) ||
    request.expiresAt < value.createdAt ||
    consumed.energy > grant.energy ||
    consumed.cpu > grant.cpu ||
    (grant.spawn === null && consumed.spawn) ||
    !grantMatchesRequest(grant, request) ||
    ((value.status === "active" || value.status === "consumed" || !grantIsZero(grant)) &&
      !grantSatisfiesRequest(grant, request)) ||
    (value.status === "consumed" && !grantIsFullyConsumed(grant, consumed)) ||
    (value.status === "active" && !grantIsZero(grant) && grantIsFullyConsumed(grant, consumed)) ||
    ((value.status === "pending" || value.status === "expired") &&
      (grant.energy !== 0 || grant.cpu !== 0 || grant.spawn !== null))
  ) {
    return null;
  }

  return {
    reservationId: value.reservationId,
    colonyId: value.colonyId,
    category: value.category,
    issuer: value.issuer,
    revision: value.revision,
    request,
    grant,
    consumed,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status as LedgerEntry["status"],
    reasonCode: value.reasonCode as LedgerEntry["reasonCode"],
  };
}

function grantIsZero(grant: BudgetGrant): boolean {
  return grant.energy === 0 && grant.cpu === 0 && grant.spawn === null;
}

function grantSatisfiesRequest(grant: BudgetGrant, request: BudgetRequest): boolean {
  return (
    grant.energy >= (request.energy?.minimum ?? 0) &&
    grant.cpu >= (request.cpu?.minimum ?? 0) &&
    (request.spawn === null || grant.spawn !== null)
  );
}

function grantIsFullyConsumed(grant: BudgetGrant, consumed: BudgetConsumption): boolean {
  return (
    grant.energy === consumed.energy &&
    grant.cpu === consumed.cpu &&
    (grant.spawn === null || consumed.spawn)
  );
}

function parseRequest(value: unknown): BudgetRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) {
    return null;
  }
  const energy = value.energy === null ? null : parseClaim(value.energy);
  const cpu = value.cpu === null ? null : parseClaim(value.cpu);
  const spawn = value.spawn === null ? null : parseInterval(value.spawn);
  if (
    (value.energy !== null && energy === null) ||
    (value.cpu !== null && cpu === null) ||
    (value.spawn !== null && spawn === null) ||
    !isIdentifier(value.colonyId, 64) ||
    typeof value.category !== "string" ||
    !BUDGET_CATEGORIES.includes(value.category as BudgetRequest["category"]) ||
    !isIdentifier(value.issuer, MAX_BUDGET_ISSUER_CODE_UNITS) ||
    !isSafeInteger(value.revision) ||
    !isSafeInteger(value.expiresAt) ||
    (energy === null && cpu === null && spawn === null)
  ) {
    return null;
  }
  return {
    colonyId: value.colonyId,
    category: value.category as BudgetRequest["category"],
    issuer: value.issuer,
    revision: value.revision,
    expiresAt: value.expiresAt,
    energy,
    cpu,
    spawn,
  };
}

function parseClaim(value: unknown): ElasticBudgetClaim | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CLAIM_KEYS) ||
    !isSafeInteger(value.minimum) ||
    !isSafeInteger(value.desired) ||
    value.minimum > value.desired
  ) {
    return null;
  }
  return { minimum: value.minimum, desired: value.desired };
}

function parseInterval(value: unknown): SpawnIntervalClaim | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, INTERVAL_KEYS) ||
    !isIdentifier(value.spawnId, 128) ||
    !isSafeInteger(value.startTick) ||
    !isSafeInteger(value.endTick) ||
    value.endTick <= value.startTick ||
    value.endTick - value.startTick > MAX_SPAWN_INTERVAL_TICKS
  ) {
    return null;
  }
  return { spawnId: value.spawnId, startTick: value.startTick, endTick: value.endTick };
}

function parseGrant(value: unknown): BudgetGrant | null {
  if (!isRecord(value) || !hasExactKeys(value, GRANT_KEYS)) {
    return null;
  }
  const spawn = value.spawn === null ? null : parseInterval(value.spawn);
  if (
    !isSafeInteger(value.energy) ||
    !isSafeInteger(value.cpu) ||
    (value.spawn !== null && spawn === null)
  ) {
    return null;
  }
  return { energy: value.energy, cpu: value.cpu, spawn };
}

function parseConsumption(value: unknown): BudgetConsumption | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONSUMPTION_KEYS) ||
    !isSafeInteger(value.energy) ||
    !isSafeInteger(value.cpu) ||
    typeof value.spawn !== "boolean"
  ) {
    return null;
  }
  return { energy: value.energy, cpu: value.cpu, spawn: value.spawn };
}

function grantMatchesRequest(grant: BudgetGrant, request: BudgetRequest): boolean {
  if (grant.energy > (request.energy?.desired ?? 0) || grant.cpu > (request.cpu?.desired ?? 0)) {
    return false;
  }
  if (grant.spawn === null || request.spawn === null) {
    return grant.spawn === request.spawn || grant.spawn === null;
  }
  return (
    grant.spawn.spawnId === request.spawn.spawnId &&
    grant.spawn.startTick === request.spawn.startTick &&
    grant.spawn.endTick === request.spawn.endTick
  );
}

function compareLedgerEntries(left: LedgerEntry, right: LedgerEntry): number {
  return compareStrings(ledgerIssuerKey(left), ledgerIssuerKey(right));
}

function isStrictlySorted<T>(values: readonly T[], key: (value: T) => string): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareStrings(key(previous), key(current)) >= 0
    ) {
      return false;
    }
  }
  return true;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !hasControlCodeUnit(value) &&
    !hasLoneSurrogate(value)
  );
}

function hasControlCodeUnit(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function isDataArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  try {
    return Reflect.ownKeys(value).every((key) => {
      if (key === "length") {
        return true;
      }
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)) {
        return false;
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
