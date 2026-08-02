import type { JsonObject } from "../state/schema";
import { redactUntrusted } from "../security";
import {
  CONTRACT_LEDGER_SCHEMA_VERSION,
  CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION,
  CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION,
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
  contractOutcomeRequestDigest,
  createEmptyContractLedgerState,
  isContractOutcomeRequestDigest,
  isContractOutcomeRequestDigestCandidate,
  normalizeContractRequest,
  requestSignature,
  type ActiveWorkContractState,
  type ContractHistoryEvent,
  type ContractIssuerFrontier,
  type ContractLease,
  type ContractLedgerRuntimeState,
  type ContractExecutionTerms,
  type ContractLedgerStateV1,
  type ContractLedgerStateV3,
  type ContractOutcome,
  type PersistedContractExecutionV3,
  type PersistedContractHistoryV3,
  type PersistedContractIssuerFrontierV3,
  type PersistedContractOutcomeV3,
  type PersistedWorkContractRecordV3,
  type TerminalWorkContractState,
  type WorkContractRecord,
  type WorkContractRequest,
  type WorkContractState,
} from "./contracts";

export type ContractLedgerStateOpenResult =
  | {
      readonly initialized: true;
      readonly state: ContractLedgerRuntimeState;
      readonly status: "ready";
    }
  | {
      readonly initialized: false;
      readonly state: ContractLedgerRuntimeState;
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
const EXECUTION_V4_KEYS = [
  "action",
  "completion",
  "counterpartId",
  "originRoomName",
  "resourceType",
  "routeRoomNames",
  "routeTravelTicks",
  "signText",
  "targetReservationTicks",
  "version",
] as const;
const EXECUTION_V5_KEYS = [
  "action",
  "completion",
  "counterpartId",
  "offload",
  "originRoomName",
  "resourceType",
  "routeRoomNames",
  "routeTravelTicks",
  "version",
  "workPosition",
] as const;
const EXECUTION_V6_KEYS = [
  "acquireOriginRoomName",
  "acquireRouteRoomNames",
  "acquireRouteTravelTicks",
  "action",
  "completion",
  "counterpartId",
  "deliverOriginRoomName",
  "deliverRouteRoomNames",
  "deliverRouteTravelTicks",
  "flowId",
  "recommendedCarry",
  "recommendedMove",
  "reservedAmount",
  "resourceType",
  "sinkBaselineAmount",
  "sinkNodeId",
  "sinkPosition",
  "sinkTargetId",
  "sourceNodeId",
  "sourcePosition",
  "sourceTargetId",
  "stage",
  "version",
] as const;

const PREVIOUS_RECORD_KEYS = [
  ...REQUEST_KEYS,
  "history",
  "id",
  "lease",
  "requestSignature",
  "revision",
  "state",
] as const;

const RECORD_KEYS = [...REQUEST_KEYS, "history", "id", "lease", "revision", "state"] as const;

const LEGAL_TRANSITIONS: Readonly<Record<ActiveWorkContractState, readonly WorkContractState[]>> = {
  proposed: ["funded", "cancelled", "expired"],
  funded: ["assigned", "suspended", "cancelled", "expired"],
  assigned: ["active", "suspended", "cancelled", "expired", "failed"],
  active: ["completed", "suspended", "cancelled", "expired", "failed"],
  suspended: ["funded", "cancelled", "expired", "failed"],
};

type SupportedContractLedgerSchemaVersion =
  | typeof CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION
  | typeof CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION
  | typeof CONTRACT_LEDGER_SCHEMA_VERSION;

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
    const state = parseContractLedgerState(value);
    return {
      // Valid legacy encodings remain authority, but are staged once even if gameplay is idle.
      initialized: requiresCanonicalV3Persistence(value),
      state,
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

export function validateContractLedgerState(value: unknown): ContractLedgerStateV3 {
  return persistedState(parseContractLedgerState(value));
}

export function serializeContractLedgerState(
  state: ContractLedgerStateV1 | ContractLedgerStateV3,
): JsonObject {
  return cloneJson(validateContractLedgerState(state)) as JsonObject;
}

export function isLegalContractTransition(
  from: ActiveWorkContractState,
  to: WorkContractState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

function parseContractLedgerState(value: unknown): ContractLedgerRuntimeState {
  const root = requireRecord(value, "$", [
    "active",
    "issuerFrontiers",
    "outcomes",
    "schemaVersion",
  ]);
  if (
    root.schemaVersion !== CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION &&
    root.schemaVersion !== CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION &&
    root.schemaVersion !== CONTRACT_LEDGER_SCHEMA_VERSION
  ) {
    invalid("invalid-schema-version", "$.schemaVersion", "must equal 1, 2, or 3");
  }
  const schemaVersion = root.schemaVersion;

  const activeRaw = requireArray(root.active, "$.active", MAX_ACTIVE_CONTRACTS);
  const frontiersRaw = requireArray(
    root.issuerFrontiers,
    "$.issuerFrontiers",
    MAX_CONTRACT_ISSUERS,
  );
  const outcomesRaw = requireArray(root.outcomes, "$.outcomes", MAX_CONTRACT_OUTCOMES);
  const active = activeRaw.map((record, index) => {
    const path = `$.active[${String(index)}]`;
    return schemaVersion === CONTRACT_LEDGER_SCHEMA_VERSION
      ? parseRecordV3(record, path)
      : parseRecord(record, path, schemaVersion);
  });
  const outcomes = outcomesRaw.map((outcome, index) => {
    const path = `$.outcomes[${String(index)}]`;
    return schemaVersion === CONTRACT_LEDGER_SCHEMA_VERSION
      ? parseOutcomeV3(outcome, path)
      : parseOutcome(outcome, path, schemaVersion);
  });
  const issuerFrontiers = frontiersRaw.map((frontier, index) => {
    const path = `$.issuerFrontiers[${String(index)}]`;
    return schemaVersion === CONTRACT_LEDGER_SCHEMA_VERSION
      ? parseIssuerFrontierV3(frontier, path)
      : parseIssuerFrontier(frontier, path);
  });

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

function parseRecord(
  value: unknown,
  path: string,
  schemaVersion:
    typeof CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION | typeof CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION,
): WorkContractRecord {
  const record = requireRecord(value, path, recordKeysFor(value, schemaVersion));
  const request = parseRequest(record, path);
  const id = requireString(record.id, `${path}.id`, 1, 512);
  if (id !== contractIdFor(request.issuer, request.issuerKey, request.issuerSequence)) {
    invalid("invalid-contract-id", `${path}.id`, "does not match the issuer identity");
  }
  const derivedSignature = requestSignature(request);
  const signature =
    schemaVersion === CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION
      ? requireString(record.requestSignature, `${path}.requestSignature`, 1, 16_384)
      : derivedSignature;
  if (signature !== derivedSignature) {
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
    parseHistoryEvent(event, `${path}.history[${String(index)}]`, schemaVersion),
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

function parseRecordV3(value: unknown, path: string): WorkContractRecord {
  const tuple = requireTuple(value, path, 25);
  const budgetBinding = requireTuple(tuple[0], `${path}[0]`, 2);
  const conditions = requireTuple(tuple[1], `${path}[1]`, 3);
  const execution =
    tuple[3] === null ? undefined : expandPersistedExecutionV3(tuple[3], `${path}[3]`);
  const leasePolicy = requireTuple(tuple[11], `${path}[11]`, 3);
  const owner = requireTuple(tuple[13], `${path}[13]`, 2);
  const priority = requireTuple(tuple[15], `${path}[15]`, 2);
  const capability = requireTuple(tuple[18], `${path}[18]`, CAPABILITY_KEYS.length);
  const target = requireTuple(tuple[19], `${path}[19]`, 3);
  const issuer = requireString(tuple[7], `${path}[7]`, 1, 128);
  const issuerKey = requireString(tuple[8], `${path}[8]`, 1, 256);
  const issuerSequence = requireInteger(tuple[9], `${path}[9]`, 0);
  const lease = tuple[22] === null ? null : expandPersistedLeaseV3(tuple[22], `${path}[22]`);
  const expanded = {
    budgetBinding: { category: budgetBinding[0], issuer: budgetBinding[1] },
    conditions: {
      cancellation: conditions[0],
      failure: conditions[1],
      success: conditions[2],
    },
    deadline: tuple[2],
    ...(execution === undefined ? {} : { execution }),
    earliestStart: tuple[4],
    estimatedWorkTicks: tuple[5],
    expiresAt: tuple[6],
    history: expandPersistedHistoryV3(tuple[21], `${path}[21]`),
    id: contractIdFor(issuer, issuerKey, issuerSequence),
    issuer,
    issuerKey,
    issuerSequence,
    kind: tuple[10],
    lease,
    leasePolicy: {
      duration: leasePolicy[0],
      switchingPenalty: leasePolicy[1],
      ttlSafetyMargin: leasePolicy[2],
    },
    maxAssignmentCost: tuple[12],
    owner: { id: owner[0], kind: owner[1] },
    preconditionKeys: tuple[14],
    priority: { class: priority[0], value: priority[1] },
    quantity: tuple[16],
    range: tuple[17],
    requiredCapability: Object.fromEntries(
      CAPABILITY_KEYS.map((key, index) => [key, capability[index]]),
    ),
    revision: tuple[23],
    state: tuple[24],
    target: { roomName: target[0], x: target[1], y: target[2] },
    targetId: tuple[20],
  };
  return parseRecord(expanded, path, CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION);
}

function expandPersistedExecutionV3(value: unknown, path: string): Record<string, unknown> {
  const discriminator = requireArray(value, path, 23)[0];
  const version = requireInteger(discriminator, `${path}[0]`, 1);
  if (version === 1) {
    const tuple = requireTuple(value, path, 6);
    return {
      action: tuple[1],
      completion: tuple[2],
      completionHits: tuple[3],
      counterpartId: tuple[4],
      resourceType: tuple[5],
      version: 1,
    };
  }
  if (version === 2) {
    const tuple = requireTuple(value, path, 6);
    return {
      action: "harvest",
      completion: tuple[1],
      counterpartId: tuple[2],
      resourceType: null,
      version: 2,
      workPosition: { roomName: tuple[3], x: tuple[4], y: tuple[5] },
    };
  }
  if (version === 3) {
    const tuple = requireTuple(value, path, 10);
    return {
      action: tuple[1],
      completion: tuple[2],
      counterpartId: tuple[3],
      flowId: tuple[4],
      recommendedCarry: tuple[5],
      recommendedMove: tuple[6],
      reservedAmount: tuple[7],
      resourceType: tuple[8],
      stage: tuple[9],
      version: 3,
    };
  }
  if (version === 4) {
    const tuple = requireTuple(value, path, 6);
    return {
      action: "reserve-controller",
      completion: "work-complete",
      counterpartId: null,
      originRoomName: tuple[1],
      resourceType: null,
      routeRoomNames: tuple[2],
      routeTravelTicks: tuple[3],
      signText: tuple[4],
      targetReservationTicks: tuple[5],
      version: 4,
    };
  }
  if (version === 5) {
    const tuple = requireTuple(value, path, 7);
    return {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      offload: "container-or-drop",
      originRoomName: tuple[1],
      resourceType: null,
      routeRoomNames: tuple[2],
      routeTravelTicks: tuple[3],
      version: 5,
      workPosition: { roomName: tuple[4], x: tuple[5], y: tuple[6] },
    };
  }
  if (version === 6) {
    const tuple = requireTuple(value, path, 23);
    const sinkPosition = requireTuple(tuple[17], `${path}[17]`, 3);
    const sourcePosition = requireTuple(tuple[20], `${path}[20]`, 3);
    return {
      acquireOriginRoomName: tuple[4],
      acquireRouteRoomNames: tuple[5],
      acquireRouteTravelTicks: tuple[6],
      action: tuple[1],
      completion: tuple[2],
      counterpartId: tuple[3],
      deliverOriginRoomName: tuple[7],
      deliverRouteRoomNames: tuple[8],
      deliverRouteTravelTicks: tuple[9],
      flowId: tuple[10],
      recommendedCarry: tuple[11],
      recommendedMove: tuple[12],
      reservedAmount: tuple[13],
      resourceType: tuple[14],
      sinkBaselineAmount: tuple[15],
      sinkNodeId: tuple[16],
      sinkPosition: { roomName: sinkPosition[0], x: sinkPosition[1], y: sinkPosition[2] },
      sinkTargetId: tuple[18],
      sourceNodeId: tuple[19],
      sourcePosition: {
        roomName: sourcePosition[0],
        x: sourcePosition[1],
        y: sourcePosition[2],
      },
      sourceTargetId: tuple[21],
      stage: tuple[22],
      version: 6,
    };
  }
  invalid("invalid-execution-version", `${path}[0]`, "must equal 1, 2, 3, 4, 5, or 6");
}

function expandPersistedHistoryV3(value: unknown, path: string): readonly unknown[] {
  const tuple = requireTuple(value, path, 2);
  const transitions = requireArray(tuple[1], `${path}[1]`, MAX_CONTRACT_HISTORY);
  let from = tuple[0];
  return transitions.map((transition, index) => {
    const eventPath = `${path}[1][${String(index)}]`;
    const event = requireTuple(transition, eventPath, 3);
    const expanded = [from, event[0], event[1], event[2]] as const;
    from = event[2];
    return expanded;
  });
}

function expandPersistedLeaseV3(value: unknown, path: string): Record<string, unknown> {
  const tuple = requireTuple(value, path, 6);
  return {
    actorId: tuple[0],
    actorName: tuple[1],
    assignedAt: tuple[2],
    assignmentCost: tuple[3],
    expiresAt: tuple[4],
    travelTicks: tuple[5],
  };
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
              : isRecord(record.execution) && record.execution.version === 4
                ? EXECUTION_V4_KEYS
                : isRecord(record.execution) && record.execution.version === 5
                  ? EXECUTION_V5_KEYS
                  : isRecord(record.execution) && record.execution.version === 6
                    ? EXECUTION_V6_KEYS
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

function parseHistoryEvent(
  value: unknown,
  path: string,
  schemaVersion:
    typeof CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION | typeof CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION,
): ContractHistoryEvent {
  if (schemaVersion === CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION && Array.isArray(value)) {
    const tuple = requireArray(value, path, 4);
    if (tuple.length !== 4) {
      invalid("invalid-history-tuple", path, "must contain exactly four fields");
    }
    return validatedHistoryEvent(tuple[0], tuple[1], tuple[2], tuple[3], path, [
      "[0]",
      "[1]",
      "[2]",
      "[3]",
    ]);
  }

  const event = requireRecord(value, path, ["from", "reason", "tick", "to"]);
  return validatedHistoryEvent(event.from, event.reason, event.tick, event.to, path, [
    ".from",
    ".reason",
    ".tick",
    ".to",
  ]);
}

function validatedHistoryEvent(
  fromValue: unknown,
  reasonValue: unknown,
  tickValue: unknown,
  toValue: unknown,
  path: string,
  suffixes: readonly [string, string, string, string],
): ContractHistoryEvent {
  const from = fromValue === null ? null : requireState(fromValue, `${path}${suffixes[0]}`);
  const to = requireState(toValue, `${path}${suffixes[3]}`);
  if (
    from === null ? to !== "proposed" : !isActiveState(from) || !isLegalContractTransition(from, to)
  ) {
    invalid("illegal-history-transition", path, "contains an illegal state transition");
  }
  return {
    from,
    reason: requireString(reasonValue, `${path}${suffixes[1]}`, 1, 128),
    tick: requireInteger(tickValue, `${path}${suffixes[2]}`, 0),
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

function parseOutcome(
  value: unknown,
  path: string,
  schemaVersion: SupportedContractLedgerSchemaVersion,
): ContractOutcome {
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
  const digest = parseOutcomeDigest(
    signature,
    { issuer, issuerKey, issuerSequence },
    `${path}.requestSignature`,
    schemaVersion,
  );
  return {
    id,
    issuer,
    issuerKey,
    issuerSequence,
    reason: requireString(outcome.reason, `${path}.reason`, 1, 128),
    requestSignature: digest,
    revision: requireInteger(outcome.revision, `${path}.revision`, 1),
    state: requireTerminalState(outcome.state, `${path}.state`),
    tick: requireInteger(outcome.tick, `${path}.tick`, 0),
  };
}

function parseOutcomeV3(value: unknown, path: string): ContractOutcome {
  const tuple = requireTuple(value, path, 8);
  const issuer = requireString(tuple[0], `${path}[0]`, 1, 128);
  const issuerKey = requireString(tuple[1], `${path}[1]`, 1, 256);
  const issuerSequence = requireInteger(tuple[2], `${path}[2]`, 0);
  return parseOutcome(
    {
      id: contractIdFor(issuer, issuerKey, issuerSequence),
      issuer,
      issuerKey,
      issuerSequence,
      reason: tuple[3],
      requestSignature: tuple[4],
      revision: tuple[5],
      state: tuple[6],
      tick: tuple[7],
    },
    path,
    CONTRACT_LEDGER_SCHEMA_VERSION,
  );
}

function parseOutcomeDigest(
  signature: string,
  identity: Pick<ContractOutcome, "issuer" | "issuerKey" | "issuerSequence">,
  path: string,
  schemaVersion: SupportedContractLedgerSchemaVersion,
): string {
  if (
    schemaVersion !== CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION &&
    isContractOutcomeRequestDigest(signature)
  ) {
    return signature;
  }
  if (
    schemaVersion !== CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION &&
    isContractOutcomeRequestDigestCandidate(signature)
  ) {
    invalid("invalid-outcome-request-digest", path, "must use the versioned digest format");
  }
  if (schemaVersion === CONTRACT_LEDGER_SCHEMA_VERSION) {
    invalid("invalid-outcome-request-digest", path, "must use the versioned digest format");
  }

  const signedRequest = parseOutcomeRequestSignature(signature, path);
  if (
    signedRequest.issuer !== identity.issuer ||
    signedRequest.issuerKey !== identity.issuerKey ||
    signedRequest.issuerSequence !== identity.issuerSequence
  ) {
    invalid(
      "invalid-outcome-request-identity",
      path,
      "must encode the same issuer identity as the outcome",
    );
  }
  return contractOutcomeRequestDigest(signedRequest);
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

function recordKeysFor(
  value: unknown,
  schemaVersion:
    typeof CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION | typeof CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION,
): readonly string[] {
  const keys =
    schemaVersion === CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION ? PREVIOUS_RECORD_KEYS : RECORD_KEYS;
  return isRecord(value) && hasOwn(value, "execution") ? [...keys, "execution"] : keys;
}

function compactActiveRecordV3(record: WorkContractRecord): PersistedWorkContractRecordV3 {
  return [
    [record.budgetBinding.category, record.budgetBinding.issuer],
    [record.conditions.cancellation, record.conditions.failure, record.conditions.success],
    record.deadline,
    record.execution === undefined ? null : compactExecutionV3(record.execution),
    record.earliestStart,
    record.estimatedWorkTicks,
    record.expiresAt,
    record.issuer,
    record.issuerKey,
    record.issuerSequence,
    record.kind,
    [
      record.leasePolicy.duration,
      record.leasePolicy.switchingPenalty,
      record.leasePolicy.ttlSafetyMargin,
    ],
    record.maxAssignmentCost,
    [record.owner.id, record.owner.kind],
    record.preconditionKeys,
    [record.priority.class, record.priority.value],
    record.quantity,
    record.range,
    CAPABILITY_KEYS.map(
      (key) => record.requiredCapability[key],
    ) as unknown as PersistedWorkContractRecordV3[18],
    [record.target.roomName, record.target.x, record.target.y],
    record.targetId,
    compactHistoryV3(record.history),
    record.lease === null
      ? null
      : [
          record.lease.actorId,
          record.lease.actorName,
          record.lease.assignedAt,
          record.lease.assignmentCost,
          record.lease.expiresAt,
          record.lease.travelTicks,
        ],
    record.revision,
    record.state,
  ];
}

function compactExecutionV3(execution: ContractExecutionTerms): PersistedContractExecutionV3 {
  if (execution.version === 1)
    return [
      1,
      execution.action,
      execution.completion,
      execution.completionHits ?? null,
      execution.counterpartId,
      execution.resourceType,
    ];
  if (execution.version === 2)
    return [
      2,
      execution.completion,
      execution.counterpartId,
      execution.workPosition.roomName,
      execution.workPosition.x,
      execution.workPosition.y,
    ];
  if (execution.version === 3)
    return [
      3,
      execution.action,
      execution.completion,
      execution.counterpartId,
      execution.flowId,
      execution.recommendedCarry,
      execution.recommendedMove,
      execution.reservedAmount,
      execution.resourceType,
      execution.stage,
    ];
  if (execution.version === 4)
    return [
      4,
      execution.originRoomName,
      execution.routeRoomNames,
      execution.routeTravelTicks,
      execution.signText,
      execution.targetReservationTicks,
    ];
  if (execution.version === 5)
    return [
      5,
      execution.originRoomName,
      execution.routeRoomNames,
      execution.routeTravelTicks,
      execution.workPosition.roomName,
      execution.workPosition.x,
      execution.workPosition.y,
    ];
  return [
    6,
    execution.action,
    execution.completion,
    execution.counterpartId,
    execution.acquireOriginRoomName,
    execution.acquireRouteRoomNames,
    execution.acquireRouteTravelTicks,
    execution.deliverOriginRoomName,
    execution.deliverRouteRoomNames,
    execution.deliverRouteTravelTicks,
    execution.flowId,
    execution.recommendedCarry,
    execution.recommendedMove,
    execution.reservedAmount,
    execution.resourceType,
    execution.sinkBaselineAmount,
    execution.sinkNodeId,
    [execution.sinkPosition.roomName, execution.sinkPosition.x, execution.sinkPosition.y],
    execution.sinkTargetId,
    execution.sourceNodeId,
    [execution.sourcePosition.roomName, execution.sourcePosition.x, execution.sourcePosition.y],
    execution.sourceTargetId,
    execution.stage,
  ];
}

function compactHistoryV3(history: readonly ContractHistoryEvent[]): PersistedContractHistoryV3 {
  const first = history[0];
  if (first === undefined) {
    throw new ContractValidationError("missing-history", "$.history", "must not be empty");
  }
  return [first.from, history.map(({ reason, tick, to }) => [reason, tick, to] as const)];
}

function compactOutcomeV3(outcome: ContractOutcome): PersistedContractOutcomeV3 {
  return [
    outcome.issuer,
    outcome.issuerKey,
    outcome.issuerSequence,
    outcome.reason,
    outcome.requestSignature,
    outcome.revision,
    outcome.state,
    outcome.tick,
  ];
}

function persistedState(state: ContractLedgerRuntimeState): ContractLedgerStateV3 {
  return deepFreeze({
    active: state.active.map(compactActiveRecordV3),
    issuerFrontiers: state.issuerFrontiers.map(
      ({ issuer, retiredThrough }) => [issuer, retiredThrough] as PersistedContractIssuerFrontierV3,
    ),
    outcomes: state.outcomes.map(compactOutcomeV3),
    schemaVersion: CONTRACT_LEDGER_SCHEMA_VERSION,
  });
}

function requiresCanonicalV3Persistence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === CONTRACT_LEDGER_LEGACY_SCHEMA_VERSION ||
    value.schemaVersion === CONTRACT_LEDGER_PREVIOUS_SCHEMA_VERSION
  );
}

function parseIssuerFrontier(value: unknown, path: string): ContractIssuerFrontier {
  const frontier = requireRecord(value, path, ["issuer", "retiredThrough"]);
  return {
    issuer: requireString(frontier.issuer, `${path}.issuer`, 1, 128),
    retiredThrough: requireInteger(frontier.retiredThrough, `${path}.retiredThrough`, 0),
  };
}

function parseIssuerFrontierV3(value: unknown, path: string): ContractIssuerFrontier {
  const tuple = requireTuple(value, path, 2);
  return {
    issuer: requireString(tuple[0], `${path}[0]`, 1, 128),
    retiredThrough: requireInteger(tuple[1], `${path}[1]`, 0),
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

function requireTuple(value: unknown, path: string, length: number): readonly unknown[] {
  const tuple = requireArray(value, path, length);
  if (tuple.length !== length) {
    invalid("invalid-tuple", path, `must contain exactly ${String(length)} fields`);
  }
  return tuple;
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
