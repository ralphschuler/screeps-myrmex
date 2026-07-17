import type { JsonObject } from "../state/schema";
import { redactUntrusted } from "../security";
import {
  CONTRACT_LEDGER_SCHEMA_VERSION,
  CAPABILITY_KEYS,
  MAX_ACTIVE_CONTRACTS,
  MAX_CONTRACT_HISTORY,
  MAX_CONTRACT_ISSUERS,
  MAX_CONTRACT_OUTCOMES,
  WORK_CONTRACT_STATES,
  ContractValidationError,
  compareStrings,
  contractFundingBindingKey,
  contractIdFor,
  createEmptyContractLedgerState,
  normalizeContractRequest,
  requestSignature,
  type ActiveWorkContractState,
  type ContractHistoryEvent,
  type ContractIssuerFrontier,
  type ContractLease,
  type ContractLedgerStateV1,
  type ContractOutcome,
  type TerminalWorkContractState,
  type WorkContractRecord,
  type WorkContractRequest,
  type WorkContractState,
} from "./contracts";

export type ContractLedgerStateOpenResult =
  | {
      readonly initialized: true;
      readonly state: ContractLedgerStateV1;
      readonly status: "ready";
    }
  | {
      readonly initialized: false;
      readonly state: ContractLedgerStateV1;
      readonly status: "ready";
    }
  | {
      readonly error: ContractValidationError;
      readonly status: "invalid";
    }
  | {
      readonly foundSchemaVersion: number;
      readonly status: "unsupported";
    };

const REQUEST_KEYS = [
  "budgetBinding",
  "conditions",
  "deadline",
  "earliestStart",
  "estimatedWorkTicks",
  "expiresAt",
  "issuer",
  "issuerKey",
  "issuerSequence",
  "kind",
  "leasePolicy",
  "maxAssignmentCost",
  "owner",
  "preconditionKeys",
  "priority",
  "quantity",
  "range",
  "requiredCapability",
  "target",
  "targetId",
] as const;

const EXECUTION_KEYS = [
  "action",
  "completion",
  "completionHits",
  "counterpartId",
  "resourceType",
  "version",
] as const;
const EXECUTION_V2_KEYS = [
  "action",
  "completion",
  "counterpartId",
  "resourceType",
  "version",
  "workPosition",
] as const;
const EXECUTION_V3_KEYS = [
  "action",
  "completion",
  "counterpartId",
  "flowId",
  "recommendedCarry",
  "recommendedMove",
  "reservedAmount",
  "resourceType",
  "stage",
  "version",
] as const;

const RECORD_KEYS = [
  ...REQUEST_KEYS,
  "history",
  "id",
  "lease",
  "requestSignature",
  "revision",
  "state",
] as const;

const LEGAL_TRANSITIONS: Readonly<Record<ActiveWorkContractState, readonly WorkContractState[]>> = {
  proposed: ["funded", "cancelled", "expired"],
  funded: ["assigned", "suspended", "cancelled", "expired"],
  assigned: ["active", "suspended", "cancelled", "expired", "failed"],
  active: ["completed", "suspended", "cancelled", "expired", "failed"],
  suspended: ["funded", "cancelled", "expired", "failed"],
};

export function openContractLedgerState(value: unknown): ContractLedgerStateOpenResult {
  if (isRecord(value) && Object.keys(value).length === 0) {
    return {
      initialized: true,
      state: createEmptyContractLedgerState(),
      status: "ready",
    };
  }

  if (
    isRecord(value) &&
    Number.isSafeInteger(value.schemaVersion) &&
    (value.schemaVersion as number) > CONTRACT_LEDGER_SCHEMA_VERSION
  ) {
    return { foundSchemaVersion: value.schemaVersion as number, status: "unsupported" };
  }

  try {
    return {
      initialized: false,
      state: parseContractLedgerState(value),
      status: "ready",
    };
  } catch (error: unknown) {
    return {
      error:
        error instanceof ContractValidationError
          ? error
          : new ContractValidationError("invalid-ledger", "$", compactMessage(error)),
      status: "invalid",
    };
  }
}

export function validateContractLedgerState(value: unknown): ContractLedgerStateV1 {
  return parseContractLedgerState(value);
}

export function serializeContractLedgerState(state: ContractLedgerStateV1): JsonObject {
  const validated = parseContractLedgerState(state);
  return cloneJson(validated) as JsonObject;
}

export function isLegalContractTransition(
  from: ActiveWorkContractState,
  to: WorkContractState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

function parseContractLedgerState(value: unknown): ContractLedgerStateV1 {
  const root = requireRecord(value, "$", [
    "active",
    "issuerFrontiers",
    "outcomes",
    "schemaVersion",
  ]);
  if (root.schemaVersion !== CONTRACT_LEDGER_SCHEMA_VERSION) {
    invalid("invalid-schema-version", "$.schemaVersion", "must equal 1");
  }

  const activeRaw = requireArray(root.active, "$.active", MAX_ACTIVE_CONTRACTS);
  const frontiersRaw = requireArray(
    root.issuerFrontiers,
    "$.issuerFrontiers",
    MAX_CONTRACT_ISSUERS,
  );
  const outcomesRaw = requireArray(root.outcomes, "$.outcomes", MAX_CONTRACT_OUTCOMES);
  const active = activeRaw.map((record, index) =>
    parseRecord(record, `$.active[${String(index)}]`),
  );
  const outcomes = outcomesRaw.map((outcome, index) =>
    parseOutcome(outcome, `$.outcomes[${String(index)}]`),
  );
  const issuerFrontiers = frontiersRaw.map((frontier, index) =>
    parseIssuerFrontier(frontier, `$.issuerFrontiers[${String(index)}]`),
  );

  requireStrictOrder(active, (record) => record.id, "$.active");
  requireStrictOrder(issuerFrontiers, (frontier) => frontier.issuer, "$.issuerFrontiers");
  requireUnique(
    active.map((record) => record.id),
    "$.active",
    "duplicate contract id",
  );
  requireUnique(
    [...active, ...outcomes].map(contractIssuanceKey),
    "$.active",
    "one issuer sequence may identify at most one logical contract",
  );
  requireUnique(
    active.map(contractFundingBindingKey),
    "$.active",
    "one BudgetLedger binding may authorize at most one active contract",
  );

  const frontierByIssuer = new Map(
    issuerFrontiers.map((frontier) => [frontier.issuer, frontier.retiredThrough]),
  );
  for (const outcome of outcomes) {
    if ((frontierByIssuer.get(outcome.issuer) ?? -1) < outcome.issuerSequence) {
      invalid(
        "stale-issuer-frontier",
        "$.issuerFrontiers",
        "must cover every retained terminal issuance",
      );
    }
  }
  const knownIssuers = new Set([
    ...issuerFrontiers.map(({ issuer }) => issuer),
    ...active.map(({ issuer }) => issuer),
  ]);
  if (knownIssuers.size > MAX_CONTRACT_ISSUERS) {
    invalid(
      "issuer-capacity-exceeded",
      "$.issuerFrontiers",
      "active and retired issuer authorities exceed the hard cap",
    );
  }

  const leasedActors = active.flatMap((record) =>
    record.lease === null ? [] : [record.lease.actorId],
  );
  requireUnique(leasedActors, "$.active", "one actor may hold at most one primary lease");
  requireUnique(
    outcomes.map((outcome) => outcome.id),
    "$.outcomes",
    "duplicate outcome id",
  );

  const outcomeIds = new Set(outcomes.map((outcome) => outcome.id));
  for (const record of active) {
    if (outcomeIds.has(record.id)) {
      invalid("duplicate-contract-identity", "$.active", "active and terminal identities overlap");
    }
  }
  for (let index = 1; index < outcomes.length; index += 1) {
    const previous = outcomes[index - 1];
    const current = outcomes[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (previous.tick > current.tick ||
        (previous.tick === current.tick && compareStrings(previous.id, current.id) >= 0))
    ) {
      invalid("unordered-outcomes", "$.outcomes", "must be ordered by tick and id");
    }
  }

  return deepFreeze({
    active,
    issuerFrontiers,
    outcomes,
    schemaVersion: CONTRACT_LEDGER_SCHEMA_VERSION,
  });
}

function parseRecord(value: unknown, path: string): WorkContractRecord {
  const record = requireRecord(value, path, recordKeysFor(value));
  const request = parseRequest(record, path);
  const id = requireString(record.id, `${path}.id`, 1, 512);
  if (id !== contractIdFor(request.issuer, request.issuerKey, request.issuerSequence)) {
    invalid("invalid-contract-id", `${path}.id`, "does not match the issuer identity");
  }
  const signature = requireString(record.requestSignature, `${path}.requestSignature`, 1, 16_384);
  if (signature !== requestSignature(request)) {
    invalid(
      "invalid-request-signature",
      `${path}.requestSignature`,
      "does not match request terms",
    );
  }

  const state = requireActiveState(record.state, `${path}.state`);
  const revision = requireInteger(record.revision, `${path}.revision`, 1);
  const historyRaw = requireArray(record.history, `${path}.history`, MAX_CONTRACT_HISTORY);
  if (historyRaw.length === 0) {
    invalid("missing-history", `${path}.history`, "must contain the latest transition");
  }
  const history = historyRaw.map((event, index) =>
    parseHistoryEvent(event, `${path}.history[${String(index)}]`),
  );
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.from !== previous.to) {
      invalid("discontinuous-history", `${path}.history`, "events must form one transition chain");
    }
    if (current.tick < previous.tick) {
      invalid("unordered-history", `${path}.history`, "event ticks must not move backwards");
    }
  }
  const latest = history[history.length - 1];
  if (latest?.to !== state) {
    invalid("stale-history", `${path}.history`, "latest event must match current state");
  }

  const lease = record.lease === null ? null : parseLease(record.lease, `${path}.lease`);
  if ((state === "assigned" || state === "active") !== (lease !== null)) {
    invalid(
      "invalid-lease-state",
      `${path}.lease`,
      "assigned and active records require a lease; other states forbid one",
    );
  }
  if (revision < history.length) {
    invalid("invalid-revision", `${path}.revision`, "must cover the retained transition history");
  }
  if (lease !== null) {
    if (lease.expiresAt > request.expiresAt) {
      invalid("invalid-lease-expiry", `${path}.lease.expiresAt`, "must not outlive the contract");
    }
    if (
      lease.assignmentCost > request.maxAssignmentCost ||
      lease.travelTicks > lease.assignmentCost
    ) {
      invalid(
        "invalid-lease-cost",
        `${path}.lease.assignmentCost`,
        "must satisfy the contract budget and include travel cost",
      );
    }
    if (lease.assignedAt > latest.tick) {
      invalid("invalid-lease-tick", `${path}.lease.assignedAt`, "must not follow current state");
    }
  }

  return deepFreeze({
    ...request,
    history,
    id,
    lease,
    requestSignature: signature,
    revision,
    state,
  });
}

function parseRequest(
  record: Readonly<Record<string, unknown>>,
  path: string,
): WorkContractRequest {
  const budgetBinding = requireRecord(record.budgetBinding, `${path}.budgetBinding`, [
    "category",
    "issuer",
  ]);
  const conditions = requireRecord(record.conditions, `${path}.conditions`, [
    "cancellation",
    "failure",
    "success",
  ]);
  const leasePolicy = requireRecord(record.leasePolicy, `${path}.leasePolicy`, [
    "duration",
    "switchingPenalty",
    "ttlSafetyMargin",
  ]);
  const owner = requireRecord(record.owner, `${path}.owner`, ["id", "kind"]);
  const priority = requireRecord(record.priority, `${path}.priority`, ["class", "value"]);
  const requiredCapability = requireRecord(
    record.requiredCapability,
    `${path}.requiredCapability`,
    CAPABILITY_KEYS,
  );
  const target = requireRecord(record.target, `${path}.target`, ["roomName", "x", "y"]);
  const execution =
    record.execution === undefined
      ? undefined
      : requireRecord(
          record.execution,
          `${path}.execution`,
          isRecord(record.execution) && record.execution.version === 2
            ? EXECUTION_V2_KEYS
            : isRecord(record.execution) && record.execution.version === 3
              ? EXECUTION_V3_KEYS
              : EXECUTION_KEYS,
        );
  const request = {
    budgetBinding,
    conditions,
    deadline: record.deadline,
    ...(execution === undefined ? {} : { execution }),
    earliestStart: record.earliestStart,
    estimatedWorkTicks: record.estimatedWorkTicks,
    expiresAt: record.expiresAt,
    issuer: record.issuer,
    issuerKey: record.issuerKey,
    issuerSequence: record.issuerSequence,
    kind: record.kind,
    leasePolicy,
    maxAssignmentCost: record.maxAssignmentCost,
    owner,
    preconditionKeys: requireArray(record.preconditionKeys, `${path}.preconditionKeys`, 16),
    priority,
    quantity: record.quantity,
    range: record.range,
    requiredCapability,
    target,
    targetId: record.targetId,
  } as unknown as WorkContractRequest;

  try {
    return normalizeContractRequest(request);
  } catch (error: unknown) {
    if (error instanceof ContractValidationError) {
      const suffix = error.path.startsWith("$.") ? error.path.slice(1) : error.path;
      throw new ContractValidationError(error.code, `${path}${suffix}`, error.message);
    }
    throw error;
  }
}

function parseHistoryEvent(value: unknown, path: string): ContractHistoryEvent {
  const event = requireRecord(value, path, ["from", "reason", "tick", "to"]);
  const from = event.from === null ? null : requireState(event.from, `${path}.from`);
  const to = requireState(event.to, `${path}.to`);
  if (
    from === null ? to !== "proposed" : !isActiveState(from) || !isLegalContractTransition(from, to)
  ) {
    invalid("illegal-history-transition", path, "contains an illegal state transition");
  }
  return {
    from,
    reason: requireString(event.reason, `${path}.reason`, 1, 128),
    tick: requireInteger(event.tick, `${path}.tick`, 0),
    to,
  };
}

function parseLease(value: unknown, path: string): ContractLease {
  const lease = requireRecord(value, path, [
    "actorId",
    "actorName",
    "assignedAt",
    "assignmentCost",
    "expiresAt",
    "travelTicks",
  ]);
  const assignedAt = requireInteger(lease.assignedAt, `${path}.assignedAt`, 0);
  const expiresAt = requireInteger(lease.expiresAt, `${path}.expiresAt`, 1);
  if (expiresAt <= assignedAt) {
    invalid("invalid-lease-expiry", `${path}.expiresAt`, "must be after assignedAt");
  }
  return {
    actorId: requireString(lease.actorId, `${path}.actorId`, 1, 128),
    actorName: requireString(lease.actorName, `${path}.actorName`, 1, 128),
    assignedAt,
    assignmentCost: requireInteger(lease.assignmentCost, `${path}.assignmentCost`, 0),
    expiresAt,
    travelTicks: requireInteger(lease.travelTicks, `${path}.travelTicks`, 0),
  };
}

function parseOutcome(value: unknown, path: string): ContractOutcome {
  const outcome = requireRecord(value, path, [
    "id",
    "issuer",
    "issuerKey",
    "issuerSequence",
    "reason",
    "requestSignature",
    "revision",
    "state",
    "tick",
  ]);
  const issuer = requireString(outcome.issuer, `${path}.issuer`, 1, 128);
  const issuerKey = requireString(outcome.issuerKey, `${path}.issuerKey`, 1, 256);
  const issuerSequence = requireInteger(outcome.issuerSequence, `${path}.issuerSequence`, 0);
  const id = requireString(outcome.id, `${path}.id`, 1, 512);
  if (id !== contractIdFor(issuer, issuerKey, issuerSequence)) {
    invalid("invalid-outcome-id", `${path}.id`, "does not match the issuer identity");
  }
  const signature = requireString(outcome.requestSignature, `${path}.requestSignature`, 1, 16_384);
  const signedRequest = parseOutcomeRequestSignature(signature, `${path}.requestSignature`);
  if (
    signedRequest.issuer !== issuer ||
    signedRequest.issuerKey !== issuerKey ||
    signedRequest.issuerSequence !== issuerSequence
  ) {
    invalid(
      "invalid-outcome-request-identity",
      `${path}.requestSignature`,
      "must encode the same issuer identity as the outcome",
    );
  }
  return {
    id,
    issuer,
    issuerKey,
    issuerSequence,
    reason: requireString(outcome.reason, `${path}.reason`, 1, 128),
    requestSignature: signature,
    revision: requireInteger(outcome.revision, `${path}.revision`, 1),
    state: requireTerminalState(outcome.state, `${path}.state`),
    tick: requireInteger(outcome.tick, `${path}.tick`, 0),
  };
}

function parseOutcomeRequestSignature(signature: string, path: string): WorkContractRequest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(signature) as unknown;
  } catch {
    invalid(
      "invalid-outcome-request-signature",
      path,
      "must encode one canonical contract request",
    );
  }
  const record = requireRecord(decoded, path, requestKeysFor(decoded));
  const request = parseRequest(record, path);
  if (requestSignature(request) !== signature) {
    invalid("invalid-outcome-request-signature", path, "must use canonical request serialization");
  }
  return request;
}

function requestKeysFor(value: unknown): readonly string[] {
  return isRecord(value) && hasOwn(value, "execution")
    ? [...REQUEST_KEYS, "execution"]
    : REQUEST_KEYS;
}

function recordKeysFor(value: unknown): readonly string[] {
  return isRecord(value) && hasOwn(value, "execution")
    ? [...RECORD_KEYS, "execution"]
    : RECORD_KEYS;
}

function parseIssuerFrontier(value: unknown, path: string): ContractIssuerFrontier {
  const frontier = requireRecord(value, path, ["issuer", "retiredThrough"]);
  return {
    issuer: requireString(frontier.issuer, `${path}.issuer`, 1, 128),
    retiredThrough: requireInteger(frontier.retiredThrough, `${path}.retiredThrough`, 0),
  };
}

function contractIssuanceKey(
  contract: Pick<ContractOutcome | WorkContractRecord, "issuer" | "issuerSequence">,
): string {
  return `${String(contract.issuer.length)}:${contract.issuer}${String(contract.issuerSequence)}`;
}

function requireRecord(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    invalid("expected-object", path, "must be a plain object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid("unexpected-keys", path, `must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}

function requireArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid("invalid-array", path, `must be an array with at most ${String(maximum)} items`);
  }
  return value;
}

function requireInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid("invalid-integer", path, `must be a safe integer at least ${String(minimum)}`);
  }
  return value as number;
}

function requireString(value: unknown, path: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    invalid("invalid-string", path, "must be a bounded, trimmed string");
  }
  return value;
}

function requireState(value: unknown, path: string): WorkContractState {
  if (typeof value !== "string" || !WORK_CONTRACT_STATES.includes(value as WorkContractState)) {
    invalid("invalid-state", path, "must be a supported contract state");
  }
  return value as WorkContractState;
}

function requireActiveState(value: unknown, path: string): ActiveWorkContractState {
  const state = requireState(value, path);
  if (!isActiveState(state)) {
    invalid("terminal-active-record", path, "active records may not use terminal states");
  }
  return state;
}

function requireTerminalState(value: unknown, path: string): TerminalWorkContractState {
  const state = requireState(value, path);
  if (!isTerminalState(state)) {
    invalid("nonterminal-outcome", path, "outcomes require a terminal state");
  }
  return state;
}

function isActiveState(state: WorkContractState): state is ActiveWorkContractState {
  return !isTerminalState(state);
}

function isTerminalState(state: WorkContractState): state is TerminalWorkContractState {
  return (
    state === "completed" || state === "cancelled" || state === "expired" || state === "failed"
  );
}

function requireUnique(values: readonly string[], path: string, message: string): void {
  if (new Set(values).size !== values.length) {
    invalid("duplicate-value", path, message);
  }
}

function requireStrictOrder<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  path: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous !== undefined && current !== undefined && keyOf(previous) >= keyOf(current)) {
      invalid("unordered-values", path, "must use strict stable identifier order");
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid(code: string, path: string, message: string): never {
  throw new ContractValidationError(code, path, message);
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => cloneJson(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
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

function compactMessage(error: unknown): string {
  return redactUntrusted("contract-error", error);
}
