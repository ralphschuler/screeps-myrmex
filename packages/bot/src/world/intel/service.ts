import { INTENT_PRIORITY_CLASSES, type IntentPriority } from "../../execution";
import { type ObservationRequestV1, type ObserverAuthorization } from "../../observer";
import type { SegmentReadResult, SegmentService, SegmentStore } from "../../segments";
import type { WorldSnapshot } from "../snapshot";
import {
  INTEL_LIMITS,
  ROOM_INTEL_SCHEMA_VERSION,
  createRoomIntelCodec,
  projectRoomIntelRecord,
  type RoomIntelRecordV1,
} from "./room-intel";

export const INTEL_SERVICE_LIMITS = Object.freeze({
  maximumAuthorizationsPerTick: 64,
  maximumDemandIdCodeUnits: 145,
  maximumExpiryTicks: 50_000,
  maximumQueriesPerTick: 32,
  maximumRouteQueriesPerTick: 8,
  maximumRouteRooms: 16,
  maximumRouteRoomQueriesPerTick: 32,
  maximumRoomWritesPerTick: 2,
  maximumVisibleRoomsInput: 64,
  maximumVisibleRoomsPerTick: 32,
  minimumRewriteIntervalTicks: 25,
  maximumVisionDemandsPerTick: 64,
} as const);

export interface RoomIntelQuery {
  readonly roomName: string;
  readonly maximumAge: number;
  readonly expiresAfter: number;
}

export type RoomIntelFreshness = "current" | "fresh" | "stale" | "expired" | "unknown";
export type RoomIntelQuality = "complete" | "partial" | "unknown";
export type RoomIntelQueryReason =
  | "activation-pending"
  | "age-limit"
  | "current-observation"
  | "expiry-limit"
  | "fallback-pending"
  | "future-observation"
  | "invalid-query"
  | "read-budget"
  | "segment-corrupt"
  | "segment-missing"
  | "segment-ready"
  | "service-unavailable"
  | "shard-mismatch"
  | "write-pending";

export interface RoomIntelQueryResult {
  readonly roomName: string;
  readonly freshness: RoomIntelFreshness;
  readonly quality: RoomIntelQuality;
  readonly reason: RoomIntelQueryReason;
  readonly generation: number | null;
  readonly record: RoomIntelRecordV1 | null;
}

export interface RoomIntelRouteQuery {
  readonly id: string;
  /** Ordered route rooms; IntelService classifies them but never computes or selects a route. */
  readonly roomNames: readonly string[];
  readonly maximumAge: number;
  readonly expiresAfter: number;
}

export interface RoomIntelRouteResult {
  readonly id: string;
  readonly status: "ready" | "stale" | "expired" | "unavailable" | "invalid";
  readonly freshness: RoomIntelFreshness;
  readonly quality: RoomIntelQuality;
  readonly rooms: readonly RoomIntelQueryResult[];
}

export interface VisionDemandV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly issuer: string;
  readonly requestedAt: number;
  readonly deadline: number;
  readonly targetRoomName: string;
  readonly minimumObservationTick: number;
  readonly maximumIntelAge: number;
  readonly priority: IntentPriority;
  readonly observerAuthorizationId: string | null;
  readonly observerAuthorizationRevision: number | null;
  readonly scoutAuthorizationId: string | null;
  readonly scoutAuthorizationRevision: number | null;
  readonly snapshotRevision: string;
}

/** Tick-local adapter output from the existing colony BudgetLedger; IntelService cannot mint it. */
export interface VisionScoutAuthorization {
  readonly id: string;
  readonly revision: number;
  readonly issuer: string;
  readonly active: boolean;
  readonly expiresAt: number;
  readonly budgetId: string;
  readonly maximumEnergy: number;
  readonly maximumSpawnTicks: number;
  readonly maximumCpuMilli: number;
}

export interface ScoutVisionRequestV1 {
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
  readonly budgetId: string;
  readonly maximumEnergy: number;
  readonly maximumSpawnTicks: number;
  readonly maximumCpuMilli: number;
  readonly snapshotRevision: string;
}

export type VisionDemandReason =
  | "duplicate-demand"
  | "expired"
  | "intel-fresh"
  | "invalid-demand"
  | "not-yet-valid"
  | "observer-requested"
  | "scout-requested"
  | "stale-demand"
  | "unauthorized";

export interface VisionDemandDisposition {
  readonly demandId: string;
  readonly demandRevision: number;
  readonly reason: VisionDemandReason;
  readonly status: "rejected" | "requested" | "satisfied";
}

export interface VisionRefreshProjection {
  readonly dispositions: readonly VisionDemandDisposition[];
  readonly observerAuthorizations: readonly ObserverAuthorization[];
  readonly observerRequests: readonly ObservationRequestV1[];
  readonly scoutRequests: readonly ScoutVisionRequestV1[];
}

export interface IntelServiceMetrics {
  readonly visibleRooms: number;
  readonly queried: number;
  readonly current: number;
  readonly fresh: number;
  readonly stale: number;
  readonly expired: number;
  readonly loading: number;
  readonly missing: number;
  readonly corrupt: number;
  readonly partial: number;
  readonly writeOffers: number;
  readonly writeRejected: number;
  readonly observerRequests: number;
  readonly scoutRequests: number;
  readonly refreshSatisfied: number;
  readonly refreshRejected: number;
}

export interface IntelRuntimeResult {
  readonly status: "ready" | "invalid-input" | "limit-exceeded" | "unavailable";
  readonly rooms: readonly RoomIntelQueryResult[];
  readonly routes: readonly RoomIntelRouteResult[];
  readonly refresh: VisionRefreshProjection;
  readonly metrics: IntelServiceMetrics;
}

export class IntelService {
  readonly #store: SegmentStore<string, RoomIntelRecordV1>;

  public constructor(segments: SegmentService) {
    this.#store = segments.register({
      id: "world.room-intel.v1",
      owner: "IntelService",
      schemaVersion: ROOM_INTEL_SCHEMA_VERSION,
      priority: "active-colony-remote",
      maximumEncodedLength: INTEL_LIMITS.maximumEncodedRoomCodeUnits,
      keyOf: roomName,
      codec: createRoomIntelCodec(),
    });
  }

  public plan(input: {
    readonly observerAuthorizations: readonly ObserverAuthorization[];
    readonly queries: readonly RoomIntelQuery[];
    readonly routeQueries: readonly RoomIntelRouteQuery[];
    readonly scoutAuthorizations: readonly VisionScoutAuthorization[];
    readonly snapshot: WorldSnapshot;
    readonly snapshotRevision: string;
    readonly visionDemands: readonly VisionDemandV1[];
  }): IntelRuntimeResult {
    if (
      input.snapshot.rooms.length > INTEL_SERVICE_LIMITS.maximumVisibleRoomsInput ||
      input.queries.length > INTEL_SERVICE_LIMITS.maximumQueriesPerTick ||
      input.routeQueries.length > INTEL_SERVICE_LIMITS.maximumRouteQueriesPerTick ||
      input.routeQueries.reduce((total, route) => total + route.roomNames.length, 0) >
        INTEL_SERVICE_LIMITS.maximumRouteRoomQueriesPerTick ||
      input.visionDemands.length > INTEL_SERVICE_LIMITS.maximumVisionDemandsPerTick ||
      input.observerAuthorizations.length > INTEL_SERVICE_LIMITS.maximumAuthorizationsPerTick ||
      input.scoutAuthorizations.length > INTEL_SERVICE_LIMITS.maximumAuthorizationsPerTick
    ) {
      return emptyResult("limit-exceeded");
    }
    if (!boundedIdentity(input.snapshotRevision)) return emptyResult("invalid-input");

    const visible = visibleRecords(input.snapshot);
    const writes = offerVisibleRecords(this.#store, input.snapshot, visible);
    const queryCache = new Map<string, RoomIntelQueryResult>();
    const resolve = (query: RoomIntelQuery): RoomIntelQueryResult => {
      const key = `${query.roomName}\u0000${String(query.maximumAge)}\u0000${String(query.expiresAfter)}`;
      const existing = queryCache.get(key);
      if (existing !== undefined) return existing;
      const result = resolveQuery(this.#store, input.snapshot, visible, query);
      queryCache.set(key, result);
      return result;
    };
    const queryCounts = countBy(input.queries, ({ roomName: name }) => name);
    const rooms = [...input.queries]
      .sort((a, b) => compare(a.roomName, b.roomName))
      .map((query) =>
        (queryCounts.get(query.roomName) ?? 0) === 1
          ? resolve(query)
          : unknownResult(query.roomName, "invalid-query"),
      );
    const routes = projectRouteQueries(input.routeQueries, resolve);
    const refresh = projectVisionRefresh({ ...input, resolve });
    return freeze({
      status: "ready" as const,
      rooms,
      routes,
      refresh,
      metrics: metrics(
        input.snapshot.rooms.length,
        [...rooms, ...routes.flatMap((route) => route.rooms)],
        writes,
        refresh,
      ),
    });
  }
}

export function emptyIntelRuntimeResult(
  status: IntelRuntimeResult["status"] = "unavailable",
): IntelRuntimeResult {
  return emptyResult(status);
}

function visibleRecords(snapshot: WorldSnapshot): ReadonlyMap<string, RoomIntelRecordV1> {
  const values = new Map<string, RoomIntelRecordV1>();
  for (const room of [...snapshot.rooms].sort((a, b) => compare(a.name, b.name))) {
    if (room.observedAt !== snapshot.observation.tick) continue;
    const record = projectRoomIntelRecord(room, snapshot.observation.shard);
    if (record !== null) values.set(room.name, record);
  }
  return values;
}

function offerVisibleRecords(
  store: SegmentStore<string, RoomIntelRecordV1>,
  snapshot: WorldSnapshot,
  records: ReadonlyMap<string, RoomIntelRecordV1>,
): { readonly offered: number; readonly rejected: number } {
  const ordered = [...records.values()].sort(compareIngestPriority);
  if (ordered.length === 0) return { offered: 0, rejected: 0 };
  const start = snapshot.observation.tick % ordered.length;
  const window = Array.from(
    { length: Math.min(ordered.length, INTEL_SERVICE_LIMITS.maximumVisibleRoomsPerTick) },
    (_, offset) => ordered[(start + offset) % ordered.length],
  ).filter((record): record is RoomIntelRecordV1 => record !== undefined);
  const candidates = window
    .flatMap((record, windowIndex) => {
      const read = store.read(record.roomName);
      const rank = ingestCandidateRank(read, record, snapshot.observation.tick);
      return rank === null ? [] : [{ rank, record, windowIndex }];
    })
    .sort((left, right) => left.rank - right.rank || left.windowIndex - right.windowIndex)
    .slice(0, INTEL_SERVICE_LIMITS.maximumRoomWritesPerTick);
  let offered = 0;
  let rejected = 0;
  for (const { record } of candidates) {
    const result = store.write(record.roomName, record);
    if (result.accepted) offered += 1;
    else rejected += 1;
  }
  return { offered, rejected };
}

function ingestCandidateRank(
  read: SegmentReadResult<RoomIntelRecordV1>,
  current: RoomIntelRecordV1,
  tick: number,
): number | null {
  if (read.status === "loading") {
    if (read.reason === "service-unavailable") return null;
    return read.reason === "write-pending" ? 0 : 3;
  }
  if (read.status === "corrupt") return 1;
  if (read.status === "missing") return 2;
  if (read.value.observedAt > tick) return 1;
  if (
    read.value.roomName !== current.roomName ||
    read.value.shard !== current.shard ||
    roomFactsSignature(read.value) !== roomFactsSignature(current)
  ) {
    return 1;
  }
  return tick - read.value.observedAt >= INTEL_SERVICE_LIMITS.minimumRewriteIntervalTicks
    ? 4
    : null;
}

function roomFactsSignature(record: RoomIntelRecordV1): string {
  return JSON.stringify([
    record.complete,
    record.terrain,
    record.controller,
    record.mineral,
    record.mineralStatus,
    record.sources,
    record.sourceStatus,
    record.structures,
    record.structureStatus,
    record.hostiles,
    record.hostileStatus,
    record.events,
    record.eventLogStatus,
  ]);
}

function resolveQuery(
  store: SegmentStore<string, RoomIntelRecordV1>,
  snapshot: WorldSnapshot,
  visible: ReadonlyMap<string, RoomIntelRecordV1>,
  query: RoomIntelQuery,
): RoomIntelQueryResult {
  if (!validQuery(query)) return unknownResult(query.roomName, "invalid-query");
  const current = visible.get(query.roomName);
  if (current !== undefined) return readyResult(current, null, "current", "current-observation");
  const read = store.read(query.roomName);
  if (read.status === "missing") return unknownResult(query.roomName, "segment-missing");
  if (read.status === "loading") return unknownResult(query.roomName, read.reason);
  if (read.status === "corrupt") return unknownResult(query.roomName, "segment-corrupt");
  if (read.value.roomName !== query.roomName || read.value.shard !== snapshot.observation.shard) {
    return unknownResult(query.roomName, "shard-mismatch");
  }
  if (read.value.observedAt > snapshot.observation.tick) {
    return unknownResult(query.roomName, "future-observation");
  }
  const age = snapshot.observation.tick - read.value.observedAt;
  if (age <= query.maximumAge)
    return readyResult(read.value, read.generation, "fresh", "segment-ready");
  if (age <= query.expiresAfter)
    return readyResult(read.value, read.generation, "stale", "age-limit");
  return readyResult(read.value, read.generation, "expired", "expiry-limit");
}

function projectRouteQueries(
  queries: readonly RoomIntelRouteQuery[],
  resolve: (query: RoomIntelQuery) => RoomIntelQueryResult,
): readonly RoomIntelRouteResult[] {
  const counts = countBy(queries, ({ id }) => id);
  return freeze(
    [...queries]
      .sort((left, right) => compare(left.id, right.id))
      .map((query): RoomIntelRouteResult => {
        if ((counts.get(query.id) ?? 0) !== 1 || !validRouteQuery(query)) {
          return freeze({
            id: query.id,
            status: "invalid",
            freshness: "unknown",
            quality: "unknown",
            rooms: [],
          });
        }
        const rooms = query.roomNames.map((name) =>
          resolve({
            roomName: name,
            maximumAge: query.maximumAge,
            expiresAfter: query.expiresAfter,
          }),
        );
        const freshness = worstFreshness(rooms);
        const quality = rooms.some(({ quality: value }) => value === "unknown")
          ? "unknown"
          : rooms.some(({ quality: value }) => value === "partial")
            ? "partial"
            : "complete";
        const status =
          freshness === "unknown"
            ? "unavailable"
            : freshness === "expired"
              ? "expired"
              : freshness === "stale"
                ? "stale"
                : "ready";
        return freeze({ id: query.id, status, freshness, quality, rooms });
      }),
  );
}

function worstFreshness(rooms: readonly RoomIntelQueryResult[]): RoomIntelFreshness {
  const rank: Readonly<Record<RoomIntelFreshness, number>> = {
    current: 0,
    fresh: 1,
    stale: 2,
    expired: 3,
    unknown: 4,
  };
  return rooms.reduce<RoomIntelFreshness>(
    (worst, room) => (rank[room.freshness] > rank[worst] ? room.freshness : worst),
    "current",
  );
}

function projectVisionRefresh(input: {
  readonly observerAuthorizations: readonly ObserverAuthorization[];
  readonly scoutAuthorizations: readonly VisionScoutAuthorization[];
  readonly snapshot: WorldSnapshot;
  readonly snapshotRevision: string;
  readonly visionDemands: readonly VisionDemandV1[];
  readonly resolve: (query: RoomIntelQuery) => RoomIntelQueryResult;
}): VisionRefreshProjection {
  const observerAuthorizations = [...input.observerAuthorizations]
    .filter(validObserverAuthorization)
    .sort(compareAuthorization);
  const scoutAuthorizations = [...input.scoutAuthorizations]
    .filter(validScoutAuthorization)
    .sort(compareAuthorization);
  const observerCounts = countBy(observerAuthorizations, authorizationKey);
  const scoutCounts = countBy(scoutAuthorizations, authorizationKey);
  const demandCounts = countBy(input.visionDemands, ({ id }) => id);
  const dispositions: VisionDemandDisposition[] = [];
  const observerRequests: ObservationRequestV1[] = [];
  const usedObserverAuthorizations = new Map<string, ObserverAuthorization>();
  const scoutRequests: ScoutVisionRequestV1[] = [];
  const tick = input.snapshot.observation.tick;

  for (const demand of [...input.visionDemands].sort(compareDemand)) {
    if ((demandCounts.get(demand.id) ?? 0) !== 1) {
      dispositions.push(disposition(demand, "rejected", "duplicate-demand"));
      continue;
    }
    if (!validDemand(demand) || demand.snapshotRevision !== input.snapshotRevision) {
      dispositions.push(disposition(demand, "rejected", "invalid-demand"));
      continue;
    }
    if (demand.requestedAt > tick) {
      dispositions.push(disposition(demand, "rejected", "not-yet-valid"));
      continue;
    }
    if (demand.deadline < tick) {
      dispositions.push(disposition(demand, "rejected", "expired"));
      continue;
    }
    const intel = input.resolve({
      roomName: demand.targetRoomName,
      maximumAge: demand.maximumIntelAge,
      expiresAfter: INTEL_SERVICE_LIMITS.maximumExpiryTicks,
    });
    if (
      (intel.freshness === "current" || intel.freshness === "fresh") &&
      intel.record !== null &&
      intel.record.observedAt >= demand.minimumObservationTick
    ) {
      dispositions.push(disposition(demand, "satisfied", "intel-fresh"));
      continue;
    }
    const observer = findAuthorization(
      observerAuthorizations,
      observerCounts,
      demand.observerAuthorizationId,
      demand.observerAuthorizationRevision,
      demand.issuer,
      tick,
    );
    if (observer !== null) {
      observerRequests.push(observerRequest(demand, observer));
      usedObserverAuthorizations.set(authorizationKey(observer), { ...observer });
      dispositions.push(disposition(demand, "requested", "observer-requested"));
      continue;
    }
    const scout = findAuthorization(
      scoutAuthorizations,
      scoutCounts,
      demand.scoutAuthorizationId,
      demand.scoutAuthorizationRevision,
      demand.issuer,
      tick,
    );
    if (scout !== null) {
      scoutRequests.push(scoutRequest(demand, scout));
      dispositions.push(disposition(demand, "requested", "scout-requested"));
      continue;
    }
    dispositions.push(disposition(demand, "rejected", "unauthorized"));
  }

  return freeze({
    dispositions: dispositions.sort((a, b) => compare(a.demandId, b.demandId)),
    observerAuthorizations: [...usedObserverAuthorizations.values()].sort(compareAuthorization),
    observerRequests: observerRequests.sort((a, b) => compare(a.id, b.id)),
    scoutRequests: scoutRequests.sort((a, b) => compare(a.id, b.id)),
  });
}

function observerRequest(
  demand: VisionDemandV1,
  authorization: ObserverAuthorization,
): ObservationRequestV1 {
  return freeze({
    schemaVersion: 1,
    id: `intel-observer/${demand.id}`,
    revision: demand.revision,
    issuer: demand.issuer,
    requestedAt: demand.requestedAt,
    deadline: demand.deadline,
    targetRoomName: demand.targetRoomName,
    minimumObservationTick: demand.minimumObservationTick,
    priority: { ...demand.priority },
    authorizationId: authorization.id,
    authorizationRevision: authorization.revision,
    snapshotRevision: demand.snapshotRevision,
  });
}

function scoutRequest(
  demand: VisionDemandV1,
  authorization: VisionScoutAuthorization,
): ScoutVisionRequestV1 {
  return freeze({
    schemaVersion: 1,
    id: `intel-scout/${demand.id}`,
    revision: demand.revision,
    issuer: demand.issuer,
    requestedAt: demand.requestedAt,
    deadline: demand.deadline,
    targetRoomName: demand.targetRoomName,
    minimumObservationTick: demand.minimumObservationTick,
    priority: { ...demand.priority },
    authorizationId: authorization.id,
    authorizationRevision: authorization.revision,
    budgetId: authorization.budgetId,
    maximumEnergy: authorization.maximumEnergy,
    maximumSpawnTicks: authorization.maximumSpawnTicks,
    maximumCpuMilli: authorization.maximumCpuMilli,
    snapshotRevision: demand.snapshotRevision,
  });
}

function metrics(
  visibleRooms: number,
  rooms: readonly RoomIntelQueryResult[],
  writes: { readonly offered: number; readonly rejected: number },
  refresh: VisionRefreshProjection,
): IntelServiceMetrics {
  const count = (freshness: RoomIntelFreshness) =>
    rooms.filter((room) => room.freshness === freshness).length;
  return freeze({
    visibleRooms,
    queried: rooms.length,
    current: count("current"),
    fresh: count("fresh"),
    stale: count("stale"),
    expired: count("expired"),
    loading: rooms.filter(({ reason }) =>
      [
        "activation-pending",
        "fallback-pending",
        "read-budget",
        "service-unavailable",
        "write-pending",
      ].includes(reason),
    ).length,
    missing: rooms.filter(({ reason }) => reason === "segment-missing").length,
    corrupt: rooms.filter(({ reason }) =>
      ["segment-corrupt", "future-observation", "shard-mismatch"].includes(reason),
    ).length,
    partial: rooms.filter(({ quality }) => quality === "partial").length,
    writeOffers: writes.offered,
    writeRejected: writes.rejected,
    observerRequests: refresh.observerRequests.length,
    scoutRequests: refresh.scoutRequests.length,
    refreshSatisfied: refresh.dispositions.filter(({ status }) => status === "satisfied").length,
    refreshRejected: refresh.dispositions.filter(({ status }) => status === "rejected").length,
  });
}

function readyResult(
  record: RoomIntelRecordV1,
  generation: number | null,
  freshness: Exclude<RoomIntelFreshness, "unknown">,
  reason: Extract<
    RoomIntelQueryReason,
    "current-observation" | "segment-ready" | "age-limit" | "expiry-limit"
  >,
): RoomIntelQueryResult {
  return freeze({
    roomName: record.roomName,
    freshness,
    quality: record.complete ? "complete" : "partial",
    reason,
    generation,
    record,
  });
}

function unknownResult(room: string, reason: RoomIntelQueryReason): RoomIntelQueryResult {
  return freeze({
    roomName: room,
    freshness: "unknown" as const,
    quality: "unknown" as const,
    reason,
    generation: null,
    record: null,
  });
}

function emptyResult(status: IntelRuntimeResult["status"]): IntelRuntimeResult {
  return freeze({
    status,
    rooms: [],
    routes: [],
    refresh: {
      dispositions: [],
      observerAuthorizations: [],
      observerRequests: [],
      scoutRequests: [],
    },
    metrics: {
      visibleRooms: 0,
      queried: 0,
      current: 0,
      fresh: 0,
      stale: 0,
      expired: 0,
      loading: 0,
      missing: 0,
      corrupt: 0,
      partial: 0,
      writeOffers: 0,
      writeRejected: 0,
      observerRequests: 0,
      scoutRequests: 0,
      refreshSatisfied: 0,
      refreshRejected: 0,
    },
  });
}

function compareIngestPriority(left: RoomIntelRecordV1, right: RoomIntelRecordV1): number {
  const leftThreat = left.hostiles.length > 0 ? 0 : 1;
  const rightThreat = right.hostiles.length > 0 ? 0 : 1;
  return leftThreat - rightThreat || compare(left.roomName, right.roomName);
}
function validQuery(value: RoomIntelQuery): boolean {
  return (
    validRoomName(value.roomName) &&
    nonnegative(value.maximumAge) &&
    nonnegative(value.expiresAfter) &&
    value.maximumAge <= value.expiresAfter &&
    value.expiresAfter <= INTEL_SERVICE_LIMITS.maximumExpiryTicks
  );
}
function validRouteQuery(value: RoomIntelRouteQuery): boolean {
  return (
    boundedIdentity(value.id) &&
    Array.isArray(value.roomNames) &&
    value.roomNames.length > 0 &&
    value.roomNames.length <= INTEL_SERVICE_LIMITS.maximumRouteRooms &&
    value.roomNames.every(validRoomName) &&
    new Set(value.roomNames).size === value.roomNames.length &&
    nonnegative(value.maximumAge) &&
    nonnegative(value.expiresAfter) &&
    value.maximumAge <= value.expiresAfter &&
    value.expiresAfter <= INTEL_SERVICE_LIMITS.maximumExpiryTicks
  );
}
function validDemand(value: VisionDemandV1): boolean {
  return (
    validVisionDemandShape(value) &&
    boundedIdentity(value.id, INTEL_SERVICE_LIMITS.maximumDemandIdCodeUnits) &&
    positive(value.revision) &&
    boundedIdentity(value.issuer) &&
    nonnegative(value.requestedAt) &&
    nonnegative(value.deadline) &&
    value.deadline >= value.requestedAt &&
    validRoomName(value.targetRoomName) &&
    nonnegative(value.minimumObservationTick) &&
    value.minimumObservationTick <= value.deadline &&
    nonnegative(value.maximumIntelAge) &&
    value.maximumIntelAge <= INTEL_SERVICE_LIMITS.maximumExpiryTicks &&
    validPriority(value.priority) &&
    paired(value.observerAuthorizationId, value.observerAuthorizationRevision) &&
    paired(value.scoutAuthorizationId, value.scoutAuthorizationRevision) &&
    boundedIdentity(value.snapshotRevision)
  );
}
function validVisionDemandShape(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "deadline",
      "id",
      "issuer",
      "maximumIntelAge",
      "minimumObservationTick",
      "observerAuthorizationId",
      "observerAuthorizationRevision",
      "priority",
      "requestedAt",
      "revision",
      "schemaVersion",
      "scoutAuthorizationId",
      "scoutAuthorizationRevision",
      "snapshotRevision",
      "targetRoomName",
    ]) &&
    value.schemaVersion === 1
  );
}
function validPriority(value: IntentPriority): boolean {
  return (
    record(value) &&
    exactKeys(value, ["class", "value"]) &&
    typeof value.class === "string" &&
    INTENT_PRIORITY_CLASSES.includes(value.class) &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    value.value <= 100
  );
}
function paired(id: string | null, revision: number | null): boolean {
  return (id === null && revision === null) || (boundedIdentity(id) && positive(revision));
}
function validObserverAuthorization(value: ObserverAuthorization): boolean {
  return (
    validAuthorizationBase(value) &&
    exactKeys(value, ["active", "expiresAt", "id", "issuer", "revision"])
  );
}
function validScoutAuthorization(value: VisionScoutAuthorization): boolean {
  return (
    validAuthorizationBase(value) &&
    exactKeys(value, [
      "active",
      "budgetId",
      "expiresAt",
      "id",
      "issuer",
      "maximumCpuMilli",
      "maximumEnergy",
      "maximumSpawnTicks",
      "revision",
    ]) &&
    boundedIdentity(value.budgetId) &&
    nonnegative(value.maximumEnergy) &&
    nonnegative(value.maximumSpawnTicks) &&
    nonnegative(value.maximumCpuMilli)
  );
}
function validAuthorizationBase(value: unknown): value is ObserverAuthorization {
  return (
    record(value) &&
    boundedIdentity(value.id) &&
    positive(value.revision) &&
    boundedIdentity(value.issuer) &&
    typeof value.active === "boolean" &&
    nonnegative(value.expiresAt)
  );
}
function findAuthorization<
  Value extends {
    readonly id: string;
    readonly revision: number;
    readonly issuer: string;
    readonly active: boolean;
    readonly expiresAt: number;
  },
>(
  values: readonly Value[],
  counts: ReadonlyMap<string, number>,
  id: string | null,
  revision: number | null,
  issuer: string,
  tick: number,
): Value | null {
  if (id === null || revision === null) return null;
  const key = `${id}\u0000${String(revision)}`;
  const value = values.find((candidate) => authorizationKey(candidate) === key);
  return value !== undefined &&
    counts.get(key) === 1 &&
    value.active &&
    value.issuer === issuer &&
    value.expiresAt >= tick
    ? value
    : null;
}
function disposition(
  demand: Pick<VisionDemandV1, "id" | "revision">,
  status: VisionDemandDisposition["status"],
  reason: VisionDemandReason,
): VisionDemandDisposition {
  return freeze({ demandId: demand.id, demandRevision: demand.revision, reason, status });
}
function compareDemand(left: VisionDemandV1, right: VisionDemandV1): number {
  return compare(left.id, right.id) || left.revision - right.revision;
}
function compareAuthorization(
  left: { readonly id: string; readonly revision: number },
  right: { readonly id: string; readonly revision: number },
): number {
  return compare(left.id, right.id) || left.revision - right.revision;
}
function authorizationKey(value: { readonly id: string; readonly revision: number }): string {
  return `${value.id}\u0000${String(value.revision)}`;
}
function countBy<Value>(
  values: readonly Value[],
  keyOf: (value: Value) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(keyOf(value), (counts.get(keyOf(value)) ?? 0) + 1);
  return counts;
}
function roomName(value: string): string {
  if (!validRoomName(value)) throw new TypeError("Invalid room intelligence key");
  return value;
}
function validRoomName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16 && /^(W|E)\d+(N|S)\d+$/u.test(value);
}
function boundedIdentity(value: unknown, maximumCodeUnits = 160): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumCodeUnits &&
    value === value.trim()
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort(compare);
  const sorted = [...expected].sort(compare);
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
