import {
  INTENT_PRIORITY_CLASSES,
  type IntentData,
  type IntentEnvelope,
  type IntentPriority,
} from "../execution";
import type {
  MatureMechanicsCatalog,
  MatureStructureCapability,
} from "../industry/mature-capabilities";
import type { WorldSnapshot } from "../world/snapshot";

export const OBSERVER_AUTHORITY_CAPS = Object.freeze({
  authorizations: 64,
  capabilities: 128,
  identities: 160,
  intentIdentities: 256,
  observers: 32,
  pendingAttempts: 64,
  priority: 100,
  requests: 64,
  retries: 3,
  observationDelay: 1,
  roomNameLength: 16,
} as const);

export interface ObservationRequestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly issuer: string;
  readonly requestedAt: number;
  readonly deadline: number;
  readonly targetRoomName: string;
  readonly minimumObservationTick: number;
  readonly priority: IntentPriority;
  readonly authorizationId: string;
  readonly authorizationRevision: number;
  readonly snapshotRevision: string;
}

export interface ObserverAuthorization {
  readonly id: string;
  readonly revision: number;
  readonly issuer: string;
  readonly active: boolean;
  readonly expiresAt: number;
}

interface ObserverIntentPayload {
  readonly [key: string]: IntentData;
  readonly authorizationId: string;
  readonly authorizationRevision: number;
  readonly capabilityFingerprint: string;
  readonly mechanicsFingerprint: string;
  readonly observerId: string;
  readonly observerRange: number;
  readonly operateObserverPower: number;
  readonly originRoomName: string;
  readonly requestId: string;
  readonly requestRevision: number;
  readonly retry: number;
  readonly targetRoomName: string;
}

export type ObserverIntent = IntentEnvelope<"observer.observe-room", ObserverIntentPayload>;

export type ObserverDispositionReason =
  | "accepted"
  | "already-visible"
  | "duplicate-request"
  | "expired"
  | "inactive-observer"
  | "insufficient-rcl"
  | "invalid-request"
  | "missing-observer"
  | "not-yet-valid"
  | "observer-busy"
  | "out-of-range"
  | "pending-observation"
  | "stale-request"
  | "unauthorized";

export interface ObserverRequestDisposition {
  readonly observerId: string | null;
  readonly reason: ObserverDispositionReason;
  readonly requestId: string;
  readonly requestRevision: number;
  readonly status: "accepted" | "deferred" | "pending" | "rejected" | "satisfied";
}

export interface ObserverProjectionResult {
  readonly dispositions: readonly ObserverRequestDisposition[];
  readonly intents: readonly ObserverIntent[];
  readonly reason: "invalid-input" | "limit-exceeded" | null;
  readonly status: "deferred" | "ready";
}

export interface PendingObserverAttempt {
  readonly attemptId: string;
  readonly authorizationId: string;
  readonly authorizationRevision: number;
  readonly capabilityFingerprint: string;
  readonly deadline: number;
  readonly issuedAt: number;
  readonly issuer: string;
  readonly mechanicsFingerprint: string;
  readonly observeAt: number;
  readonly observerId: string;
  readonly originRoomName: string;
  readonly requestId: string;
  readonly requestRevision: number;
  readonly retry: number;
  readonly retryReady?: true;
  readonly targetRoomName: string;
}

interface Candidate {
  readonly capability: MatureStructureCapability;
  readonly originRoomName: string;
  readonly powered: boolean;
  readonly rclReady: boolean;
}

interface EligibleRequest {
  readonly candidates: readonly Candidate[];
  readonly request: ObservationRequestV1;
  readonly retry: number;
}

export function projectObserverIntents(input: {
  readonly authorizations: readonly ObserverAuthorization[];
  readonly capabilities: readonly MatureStructureCapability[];
  readonly catalog: MatureMechanicsCatalog;
  readonly pendingAttempts?: readonly PendingObserverAttempt[];
  readonly requests: readonly ObservationRequestV1[];
  readonly snapshot: WorldSnapshot;
  readonly snapshotRevision: string;
}): ObserverProjectionResult {
  if (
    input.authorizations.length > OBSERVER_AUTHORITY_CAPS.authorizations ||
    input.capabilities.length > OBSERVER_AUTHORITY_CAPS.capabilities ||
    input.capabilities.filter(({ kind }) => kind === "observer").length >
      OBSERVER_AUTHORITY_CAPS.observers ||
    (input.pendingAttempts?.length ?? 0) > OBSERVER_AUTHORITY_CAPS.pendingAttempts ||
    input.requests.length > OBSERVER_AUTHORITY_CAPS.requests
  )
    return deferred("limit-exceeded");
  if (
    input.authorizations.some((authorization) => !validAuthorization(authorization)) ||
    !identity(input.snapshotRevision) ||
    !identity(input.catalog.fingerprint) ||
    !positiveInteger(input.catalog.constants.observerRange) ||
    !positiveInteger(input.catalog.constants.operateObserverPower)
  )
    return deferred("invalid-input");

  const tick = input.snapshot.observation.tick;
  const requests = [...input.requests].sort(compareRequestIdentity);
  const requestCounts = countBy(requests, ({ id }) => id);
  const authorizations = [...input.authorizations]
    .filter(validAuthorization)
    .sort((a, b) => compare(authorizationKey(a), authorizationKey(b)));
  const authorizationCounts = countBy(authorizations, authorizationKey);
  const pending = [...(input.pendingAttempts ?? [])].sort((a, b) =>
    compare(a.attemptId, b.attemptId),
  );
  if (
    pending.some((attempt) => !isPendingObserverAttempt(attempt)) ||
    new Set(pending.map(({ attemptId }) => attemptId)).size !== pending.length
  )
    return deferred("invalid-input");
  const pendingCounts = countBy(pending, pendingKey);
  const pendingByRequest = new Map(pending.map((value) => [pendingKey(value), value] as const));
  const candidates = observerCandidates(input);
  const dispositions: ObserverRequestDisposition[] = [];
  const eligible: EligibleRequest[] = [];

  for (const request of requests) {
    const key = requestKey(request);
    if ((requestCounts.get(request.id) ?? 0) !== 1) {
      dispositions.push(disposition(request, "rejected", "duplicate-request"));
      continue;
    }
    if (!validRequest(request)) {
      dispositions.push(disposition(request, "rejected", "invalid-request"));
      continue;
    }
    if (request.snapshotRevision !== input.snapshotRevision) {
      dispositions.push(disposition(request, "rejected", "stale-request"));
      continue;
    }
    if (
      request.requestedAt > tick ||
      request.minimumObservationTick > tick + OBSERVER_AUTHORITY_CAPS.observationDelay
    ) {
      dispositions.push(disposition(request, "deferred", "not-yet-valid"));
      continue;
    }
    if (request.deadline < tick) {
      dispositions.push(disposition(request, "rejected", "expired"));
      continue;
    }
    const authorizationIdentity = `${request.authorizationId}\u0000${String(request.authorizationRevision)}`;
    const authorization = authorizations.find(
      (candidate) => authorizationKey(candidate) === authorizationIdentity,
    );
    if (
      authorization === undefined ||
      (authorizationCounts.get(authorizationIdentity) ?? 0) !== 1 ||
      !authorization.active ||
      authorization.issuer !== request.issuer ||
      authorization.expiresAt < tick
    ) {
      dispositions.push(disposition(request, "rejected", "unauthorized"));
      continue;
    }
    if (visibleAt(input.snapshot, request.targetRoomName, request.minimumObservationTick)) {
      dispositions.push(disposition(request, "satisfied", "already-visible"));
      continue;
    }
    if ((pendingCounts.get(key) ?? 0) > 1) {
      dispositions.push(disposition(request, "rejected", "invalid-request"));
      continue;
    }
    const prior = pendingByRequest.get(key);
    if (prior !== undefined && !pendingMatchesRequest(prior, request, input.catalog.fingerprint)) {
      dispositions.push(disposition(request, "rejected", "invalid-request"));
      continue;
    }
    if (prior !== undefined && prior.retryReady !== true) {
      dispositions.push(disposition(request, "pending", "pending-observation", prior.observerId));
      continue;
    }
    const reachable = candidates
      .filter((candidate) =>
        canReach(candidate, request.targetRoomName, input.catalog.constants.observerRange),
      )
      .sort((a, b) => compare(a.capability.id, b.capability.id));
    if (reachable.length === 0) {
      dispositions.push(
        disposition(
          request,
          "deferred",
          blocker(candidates, request.targetRoomName, input.catalog.constants.observerRange),
        ),
      );
      continue;
    }
    eligible.push({ candidates: reachable, request, retry: prior?.retry ?? 0 });
  }

  const orderedEligible = eligible.sort((a, b) =>
    compareRequestPriority(a.request, b.request, tick),
  );
  const observerAssignments = new Map<string, EligibleRequest>();
  const requestAssignments = new Map<string, Candidate>();
  for (const entry of orderedEligible) {
    if (!assignObserver(entry, observerAssignments, requestAssignments, new Set())) {
      dispositions.push(disposition(entry.request, "deferred", "observer-busy"));
    }
  }

  const intents: ObserverIntent[] = [];
  for (const entry of orderedEligible) {
    const candidate = requestAssignments.get(requestKey(entry.request));
    if (candidate === undefined) continue;
    intents.push(
      makeIntent(
        entry.request,
        candidate,
        input.catalog,
        input.snapshotRevision,
        tick,
        entry.retry,
      ),
    );
    dispositions.push(disposition(entry.request, "accepted", "accepted", candidate.capability.id));
  }

  return freeze({
    dispositions: freeze(dispositions.sort(compareDispositions)),
    intents: freeze(intents.sort((a, b) => compare(a.id, b.id))),
    reason: null,
    status: "ready" as const,
  });
}

export function createPendingObserverAttempt(
  intent: ObserverIntent,
  result: string,
): PendingObserverAttempt | null {
  if (result !== "OK" || !validIntent(intent)) return null;
  return freeze({
    attemptId: intent.id,
    authorizationId: intent.payload.authorizationId,
    authorizationRevision: intent.payload.authorizationRevision,
    capabilityFingerprint: intent.payload.capabilityFingerprint,
    deadline: intent.deadline,
    issuedAt: intent.tick,
    issuer: intent.issuer,
    mechanicsFingerprint: intent.payload.mechanicsFingerprint,
    observeAt: intent.tick + OBSERVER_AUTHORITY_CAPS.observationDelay,
    observerId: intent.payload.observerId,
    originRoomName: intent.payload.originRoomName,
    requestId: intent.payload.requestId,
    requestRevision: intent.payload.requestRevision,
    retry: intent.payload.retry,
    targetRoomName: intent.payload.targetRoomName,
  });
}

export function isPendingObserverAttempt(value: unknown): value is PendingObserverAttempt {
  if (!record(value)) return false;
  const expected = [
    "attemptId",
    "authorizationId",
    "authorizationRevision",
    "capabilityFingerprint",
    "deadline",
    "issuedAt",
    "issuer",
    "mechanicsFingerprint",
    "observeAt",
    "observerId",
    "originRoomName",
    "requestId",
    "requestRevision",
    "retry",
    "targetRoomName",
    ...(value.retryReady === undefined ? [] : ["retryReady"]),
  ];
  return (
    exactKeys(value, expected) &&
    identity(value.attemptId, OBSERVER_AUTHORITY_CAPS.intentIdentities) &&
    identity(value.authorizationId) &&
    positiveInteger(value.authorizationRevision) &&
    identity(value.capabilityFingerprint) &&
    nonnegativeInteger(value.deadline) &&
    nonnegativeInteger(value.issuedAt) &&
    value.deadline >= value.issuedAt &&
    identity(value.issuer) &&
    identity(value.mechanicsFingerprint) &&
    value.observeAt === value.issuedAt + OBSERVER_AUTHORITY_CAPS.observationDelay &&
    identity(value.observerId, 128) &&
    roomName(value.originRoomName) &&
    identity(value.requestId) &&
    positiveInteger(value.requestRevision) &&
    nonnegativeInteger(value.retry) &&
    value.retry < OBSERVER_AUTHORITY_CAPS.retries &&
    (value.retryReady === undefined || value.retryReady === true) &&
    roomName(value.targetRoomName)
  );
}

export type ObserverSettlementReason =
  | "awaiting-observation"
  | "awaiting-retry"
  | "deadline"
  | "no-effect"
  | "observation-timeout"
  | "retry-cap"
  | "unauthorized"
  | "visible-next-tick";

export interface ObserverAttemptSettlement {
  readonly attemptId: string;
  readonly observerId: string;
  readonly reason: ObserverSettlementReason;
  readonly requestId: string;
  readonly requestRevision: number;
  readonly retry: number;
  readonly status: "cancelled" | "pending" | "retry" | "settled";
  readonly targetRoomName: string;
}

export function reconcilePendingObserverAttempts(input: {
  readonly authorizations: readonly ObserverAuthorization[];
  readonly pendingAttempts: readonly PendingObserverAttempt[];
  readonly snapshot: WorldSnapshot;
}): readonly ObserverAttemptSettlement[] {
  if (
    input.authorizations.length > OBSERVER_AUTHORITY_CAPS.authorizations ||
    input.pendingAttempts.length > OBSERVER_AUTHORITY_CAPS.pendingAttempts ||
    input.authorizations.some((authorization) => !validAuthorization(authorization)) ||
    input.pendingAttempts.some((attempt) => !isPendingObserverAttempt(attempt)) ||
    new Set(input.pendingAttempts.map(({ attemptId }) => attemptId)).size !==
      input.pendingAttempts.length ||
    new Set(input.pendingAttempts.map(pendingKey)).size !== input.pendingAttempts.length
  )
    return freeze([]);
  const authorizations = [...input.authorizations].filter(validAuthorization);
  const authorizationCounts = countBy(authorizations, authorizationKey);
  const tick = input.snapshot.observation.tick;
  return freeze(
    [...input.pendingAttempts]
      .sort((a, b) => compare(a.attemptId, b.attemptId))
      .map((attempt) => {
        const authorization = authorizations.find(
          ({ id, revision }) =>
            id === attempt.authorizationId && revision === attempt.authorizationRevision,
        );
        if (
          authorization === undefined ||
          (authorizationCounts.get(authorizationKey(authorization)) ?? 0) !== 1 ||
          !authorization.active ||
          authorization.issuer !== attempt.issuer ||
          authorization.expiresAt < tick
        )
          return settle(attempt, "cancelled", "unauthorized", attempt.retry);
        if (attempt.retryReady === true)
          return tick > attempt.deadline
            ? settle(attempt, "cancelled", "deadline", attempt.retry)
            : settle(attempt, "pending", "awaiting-retry", attempt.retry);
        if (tick < attempt.observeAt)
          return settle(attempt, "pending", "awaiting-observation", attempt.retry);
        if (tick > attempt.observeAt)
          return settle(attempt, "cancelled", "observation-timeout", attempt.retry);
        if (visibleAt(input.snapshot, attempt.targetRoomName, attempt.observeAt))
          return settle(attempt, "settled", "visible-next-tick", attempt.retry);
        if (tick > attempt.deadline) return settle(attempt, "cancelled", "deadline", attempt.retry);
        return attempt.retry + 1 >= OBSERVER_AUTHORITY_CAPS.retries
          ? settle(attempt, "cancelled", "retry-cap", attempt.retry)
          : settle(attempt, "retry", "no-effect", attempt.retry + 1);
      }),
  );
}

export function markObserverAttemptRetryReady(
  attempt: PendingObserverAttempt,
  result: ObserverAttemptSettlement,
): PendingObserverAttempt | null {
  if (
    !isPendingObserverAttempt(attempt) ||
    result.attemptId !== attempt.attemptId ||
    result.status !== "retry" ||
    result.retry >= OBSERVER_AUTHORITY_CAPS.retries
  )
    return null;
  return freeze({ ...attempt, retry: result.retry, retryReady: true as const });
}

function assignObserver(
  entry: EligibleRequest,
  observerAssignments: Map<string, EligibleRequest>,
  requestAssignments: Map<string, Candidate>,
  visitedObservers: Set<string>,
): boolean {
  for (const candidate of entry.candidates) {
    const observerId = candidate.capability.id;
    if (visitedObservers.has(observerId)) continue;
    visitedObservers.add(observerId);
    const incumbent = observerAssignments.get(observerId);
    if (
      incumbent === undefined ||
      assignObserver(incumbent, observerAssignments, requestAssignments, visitedObservers)
    ) {
      observerAssignments.set(observerId, entry);
      requestAssignments.set(requestKey(entry.request), candidate);
      return true;
    }
  }
  return false;
}

function observerCandidates(input: Parameters<typeof projectObserverIntents>[0]): Candidate[] {
  const values: Candidate[] = [];
  const counts = countBy(
    input.capabilities.filter(({ kind }) => kind === "observer"),
    ({ id }) => id,
  );
  for (const capability of [...input.capabilities].sort((a, b) => compare(a.id, b.id))) {
    if (capability.kind !== "observer" || counts.get(capability.id) !== 1) continue;
    const room = input.snapshot.ownedRooms.find(({ name }) => name === capability.roomName);
    const observer = room?.ownedObservers?.find(({ id }) => id === capability.id);
    if (
      room === undefined ||
      observer === undefined ||
      room.observedAt !== input.snapshot.observation.tick ||
      capability.range !== input.catalog.constants.observerRange
    )
      continue;
    values.push({
      capability: { ...capability, active: capability.active && observer.active },
      originRoomName: room.name,
      powered: observer.effects.some(
        ({ effect, ticksRemaining }) =>
          effect === input.catalog.constants.operateObserverPower && ticksRemaining > 0,
      ),
      rclReady: room.controller.level === 8,
    });
  }
  return values;
}

function blocker(
  candidates: readonly Candidate[],
  target: string,
  observerRange: number,
): Extract<
  ObserverDispositionReason,
  "inactive-observer" | "insufficient-rcl" | "missing-observer" | "out-of-range"
> {
  if (candidates.length === 0) return "missing-observer";
  if (candidates.every(({ capability }) => !capability.active)) return "inactive-observer";
  const active = candidates.filter(({ capability }) => capability.active);
  if (active.every(({ rclReady }) => !rclReady)) return "insufficient-rcl";
  return active.some((candidate) => canReach(candidate, target, observerRange))
    ? "missing-observer"
    : "out-of-range";
}

function canReach(candidate: Candidate, target: string, observerRange: number): boolean {
  return (
    candidate.capability.active &&
    candidate.rclReady &&
    roomName(candidate.originRoomName) &&
    roomName(target) &&
    (candidate.powered || roomDistance(candidate.originRoomName, target) <= observerRange)
  );
}

function makeIntent(
  request: ObservationRequestV1,
  candidate: Candidate,
  catalog: MatureMechanicsCatalog,
  snapshotRevision: string,
  tick: number,
  retry: number,
): ObserverIntent {
  return freeze({
    id: `observer-command/${request.id}/${String(request.revision)}/${String(tick)}`,
    kind: "observer.observe-room" as const,
    issuer: request.issuer,
    tick,
    target: candidate.capability.id,
    snapshotRevision,
    exclusiveResourceKey: `observer/${candidate.capability.id}`,
    priority: freeze({ ...request.priority }),
    deadline: request.deadline,
    budget: freeze({ id: request.authorizationId, cost: 1 }),
    preconditions: freeze([]),
    payload: freeze({
      authorizationId: request.authorizationId,
      authorizationRevision: request.authorizationRevision,
      capabilityFingerprint: candidate.capability.fingerprint,
      mechanicsFingerprint: catalog.fingerprint,
      observerId: candidate.capability.id,
      observerRange: catalog.constants.observerRange,
      operateObserverPower: catalog.constants.operateObserverPower,
      originRoomName: candidate.originRoomName,
      requestId: request.id,
      requestRevision: request.revision,
      retry,
      targetRoomName: request.targetRoomName,
    }),
  });
}

function validIntent(intent: ObserverIntent): boolean {
  const payload = intent.payload;
  return (
    identity(intent.id, OBSERVER_AUTHORITY_CAPS.intentIdentities) &&
    nonnegativeInteger(intent.tick) &&
    intent.tick <= Number.MAX_SAFE_INTEGER - OBSERVER_AUTHORITY_CAPS.observationDelay &&
    nonnegativeInteger(intent.deadline) &&
    intent.deadline >= intent.tick &&
    identity(payload.authorizationId) &&
    positiveInteger(payload.authorizationRevision) &&
    identity(payload.capabilityFingerprint) &&
    identity(payload.mechanicsFingerprint) &&
    identity(payload.observerId, 128) &&
    positiveInteger(payload.observerRange) &&
    positiveInteger(payload.operateObserverPower) &&
    roomName(payload.originRoomName) &&
    identity(payload.requestId) &&
    positiveInteger(payload.requestRevision) &&
    nonnegativeInteger(payload.retry) &&
    payload.retry < OBSERVER_AUTHORITY_CAPS.retries &&
    roomName(payload.targetRoomName)
  );
}

function validRequest(value: unknown): value is ObservationRequestV1 {
  if (!record(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "id",
      "revision",
      "issuer",
      "requestedAt",
      "deadline",
      "targetRoomName",
      "minimumObservationTick",
      "priority",
      "authorizationId",
      "authorizationRevision",
      "snapshotRevision",
    ]) &&
    value.schemaVersion === 1 &&
    identity(value.id) &&
    positiveInteger(value.revision) &&
    identity(value.issuer) &&
    nonnegativeInteger(value.requestedAt) &&
    nonnegativeInteger(value.deadline) &&
    value.deadline >= value.requestedAt &&
    roomName(value.targetRoomName) &&
    nonnegativeInteger(value.minimumObservationTick) &&
    value.minimumObservationTick <= value.deadline &&
    validPriority(value.priority) &&
    identity(value.authorizationId) &&
    positiveInteger(value.authorizationRevision) &&
    identity(value.snapshotRevision)
  );
}

function validAuthorization(value: unknown): value is ObserverAuthorization {
  return (
    record(value) &&
    exactKeys(value, ["id", "revision", "issuer", "active", "expiresAt"]) &&
    identity(value.id) &&
    positiveInteger(value.revision) &&
    identity(value.issuer) &&
    typeof value.active === "boolean" &&
    nonnegativeInteger(value.expiresAt)
  );
}

function validPriority(value: unknown): value is IntentPriority {
  return (
    record(value) &&
    exactKeys(value, ["class", "value"]) &&
    typeof value.class === "string" &&
    INTENT_PRIORITY_CLASSES.includes(value.class as IntentPriority["class"]) &&
    Number.isFinite(value.value) &&
    Number(value.value) >= 0 &&
    Number(value.value) <= OBSERVER_AUTHORITY_CAPS.priority
  );
}

function pendingMatchesRequest(
  attempt: PendingObserverAttempt,
  request: ObservationRequestV1,
  mechanicsFingerprint: string,
): boolean {
  return (
    attempt.authorizationId === request.authorizationId &&
    attempt.authorizationRevision === request.authorizationRevision &&
    attempt.deadline === request.deadline &&
    attempt.mechanicsFingerprint === mechanicsFingerprint &&
    attempt.targetRoomName === request.targetRoomName
  );
}

function visibleAt(snapshot: WorldSnapshot, target: string, minimumTick: number): boolean {
  return (
    snapshot.rooms.some(({ name, observedAt }) => name === target && observedAt >= minimumTick) ||
    snapshot.visibility.rooms.some(
      ({ observedAt, roomName: visibleRoom, status }) =>
        visibleRoom === target &&
        status === "visible" &&
        observedAt !== null &&
        observedAt >= minimumTick,
    )
  );
}

function roomDistance(left: string, right: string): number {
  const a = roomCoordinates(left);
  const b = roomCoordinates(right);
  return a === null || b === null
    ? Number.POSITIVE_INFINITY
    : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function roomCoordinates(value: string): { readonly x: number; readonly y: number } | null {
  const match = /^(W|E)(\d+)(N|S)(\d+)$/u.exec(value);
  if (match === null) return null;
  const horizontal = Number(match[2]);
  const vertical = Number(match[4]);
  if (!Number.isSafeInteger(horizontal) || !Number.isSafeInteger(vertical)) return null;
  return {
    x: match[1] === "W" ? -horizontal - 1 : horizontal,
    y: match[3] === "N" ? -vertical - 1 : vertical,
  };
}

function compareRequestPriority(
  left: ObservationRequestV1,
  right: ObservationRequestV1,
  tick: number,
): number {
  return (
    priorityScore(right, tick) - priorityScore(left, tick) ||
    left.deadline - right.deadline ||
    left.requestedAt - right.requestedAt ||
    compareRequestIdentity(left, right)
  );
}

function priorityScore(request: ObservationRequestV1, tick: number): number {
  const classRank = INTENT_PRIORITY_CLASSES.indexOf(request.priority.class);
  const classBand = OBSERVER_AUTHORITY_CAPS.priority + 1;
  const classBase = (INTENT_PRIORITY_CLASSES.length - classRank - 1) * classBand;
  const waitingTicks = Math.max(0, tick - request.requestedAt);
  return Math.min(Number.MAX_SAFE_INTEGER, classBase + request.priority.value + waitingTicks);
}

function compareRequestIdentity(left: ObservationRequestV1, right: ObservationRequestV1): number {
  return compare(left.id, right.id) || left.revision - right.revision;
}
function compareDispositions(
  left: ObserverRequestDisposition,
  right: ObserverRequestDisposition,
): number {
  return compare(left.requestId, right.requestId) || left.requestRevision - right.requestRevision;
}
function disposition(
  request: ObservationRequestV1,
  status: ObserverRequestDisposition["status"],
  reason: ObserverDispositionReason,
  observerId: string | null = null,
): ObserverRequestDisposition {
  return freeze({
    observerId,
    reason,
    requestId: request.id,
    requestRevision: request.revision,
    status,
  });
}
function settle(
  attempt: PendingObserverAttempt,
  status: ObserverAttemptSettlement["status"],
  reason: ObserverSettlementReason,
  retry: number,
): ObserverAttemptSettlement {
  return freeze({
    attemptId: attempt.attemptId,
    observerId: attempt.observerId,
    reason,
    requestId: attempt.requestId,
    requestRevision: attempt.requestRevision,
    retry,
    status,
    targetRoomName: attempt.targetRoomName,
  });
}
function deferred(reason: "invalid-input" | "limit-exceeded"): ObserverProjectionResult {
  return freeze({ dispositions: [], intents: [], reason, status: "deferred" as const });
}
function requestKey(value: Pick<ObservationRequestV1, "id" | "revision">): string {
  return `${value.id}\u0000${String(value.revision)}`;
}
function pendingKey(value: Pick<PendingObserverAttempt, "requestId" | "requestRevision">): string {
  return `${value.requestId}\u0000${String(value.requestRevision)}`;
}
function authorizationKey(value: Pick<ObserverAuthorization, "id" | "revision">): string {
  return `${value.id}\u0000${String(value.revision)}`;
}
function countBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(keyOf(value), (counts.get(keyOf(value)) ?? 0) + 1);
  return counts;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compare);
  const canonical = [...expected].sort(compare);
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function roomName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= OBSERVER_AUTHORITY_CAPS.roomNameLength &&
    /^(W|E)\d+(N|S)\d+$/u.test(value)
  );
}
function identity(
  value: unknown,
  maximum: number = OBSERVER_AUTHORITY_CAPS.identities,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}
function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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
