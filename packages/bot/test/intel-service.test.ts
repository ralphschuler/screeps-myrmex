/// <reference types="screeps" />

import { describe, expect, it } from "vitest";
import {
  INTEL_SERVICE_LIMITS,
  IntelService,
  type RoomIntelRecordV1,
  type VisionDemandV1,
  type VisionScoutAuthorization,
} from "../src/world/intel";
import type {
  SegmentReadResult,
  SegmentService,
  SegmentStore,
  SegmentStoreContract,
  SegmentWriteResult,
} from "../src/segments";
import { emptyWorldSnapshot, type RoomSnapshot, type WorldSnapshot } from "../src/world/snapshot";
import type { ObserverAuthorization } from "../src/observer";

describe("IntelService", () => {
  it("prefers current vision and classifies segment facts against explicit freshness bounds", () => {
    const segments = new FakeSegments();
    segments.reads.set("W2N1", ready(record("W2N1", 95, true), 2));
    segments.reads.set("W3N1", ready(record("W3N1", 80, false), 3));
    segments.reads.set("W4N1", ready(record("W4N1", 20, true), 4));
    segments.reads.set("W5N1", { status: "loading", reason: "activation-pending" });
    segments.reads.set("W6N1", { status: "corrupt", reason: "checksum" });
    const service = new IntelService(segments);

    const result = service.plan({
      observerAuthorizations: [],
      queries: [
        query("W6N1", 10, 50),
        query("W4N1", 10, 50),
        query("W1N1", 10, 50),
        query("W3N1", 10, 50),
        query("W2N1", 10, 50),
        query("W5N1", 10, 50),
      ],
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: snapshot(100, [visibleRoom("W1N1", 100)]),
      snapshotRevision: "snapshot-100",
      visionDemands: [],
    });

    expect(
      result.rooms.map(({ roomName, freshness, quality, reason }) => ({
        roomName,
        freshness,
        quality,
        reason,
      })),
    ).toEqual([
      {
        roomName: "W1N1",
        freshness: "current",
        quality: "complete",
        reason: "current-observation",
      },
      { roomName: "W2N1", freshness: "fresh", quality: "complete", reason: "segment-ready" },
      { roomName: "W3N1", freshness: "stale", quality: "partial", reason: "age-limit" },
      { roomName: "W4N1", freshness: "expired", quality: "complete", reason: "expiry-limit" },
      { roomName: "W5N1", freshness: "unknown", quality: "unknown", reason: "activation-pending" },
      { roomName: "W6N1", freshness: "unknown", quality: "unknown", reason: "segment-corrupt" },
    ]);
    expect(result.rooms[0]?.record?.observedAt).toBe(100);
    expect(result.metrics).toMatchObject({
      current: 1,
      fresh: 1,
      stale: 1,
      expired: 1,
      loading: 1,
      corrupt: 1,
      queried: 6,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("projects one authorized observer-or-scout refresh path with stable reason codes", () => {
    const segments = new FakeSegments();
    segments.reads.set("W1N2", ready(record("W1N2", 90, true), 1));
    const service = new IntelService(segments);
    const observer = observerAuthorization("observer-auth", "intel");
    const scout = scoutAuthorization("scout-auth", "intel");
    const demands: VisionDemandV1[] = [
      demand("observer", "W1N1", "observer-auth", null),
      { ...demand("fresh", "W1N2", "observer-auth", "scout-auth"), minimumObservationTick: 90 },
      demand("scout", "W1N3", null, "scout-auth"),
      demand("unauthorized", "W1N4", "missing", null),
      {
        ...demand("future", "W1N5", "observer-auth", null),
        schemaVersion: 2,
      } as unknown as VisionDemandV1,
    ];

    const ordered = service.plan({
      observerAuthorizations: [observer],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [scout],
      snapshot: emptyWorldSnapshot(100, "shard0"),
      snapshotRevision: "snapshot-100",
      visionDemands: demands,
    });
    const reordered = new IntelService(segments).plan({
      observerAuthorizations: [observer],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [scout],
      snapshot: emptyWorldSnapshot(100, "shard0"),
      snapshotRevision: "snapshot-100",
      visionDemands: [...demands].reverse(),
    });

    expect(reordered).toEqual(ordered);
    expect(ordered.refresh.dispositions).toEqual([
      expect.objectContaining({ demandId: "fresh", status: "satisfied", reason: "intel-fresh" }),
      expect.objectContaining({ demandId: "future", status: "rejected", reason: "invalid-demand" }),
      expect.objectContaining({
        demandId: "observer",
        status: "requested",
        reason: "observer-requested",
      }),
      expect.objectContaining({
        demandId: "scout",
        status: "requested",
        reason: "scout-requested",
      }),
      expect.objectContaining({
        demandId: "unauthorized",
        status: "rejected",
        reason: "unauthorized",
      }),
    ]);
    expect(ordered.refresh.observerRequests).toEqual([
      expect.objectContaining({
        id: "intel-observer/observer",
        authorizationId: "observer-auth",
        targetRoomName: "W1N1",
      }),
    ]);
    expect(ordered.refresh.scoutRequests).toEqual([
      expect.objectContaining({
        id: "intel-scout/scout",
        authorizationId: "scout-auth",
        targetRoomName: "W1N3",
        maximumEnergy: 50,
        maximumSpawnTicks: 3,
        maximumCpuMilli: 250,
      }),
    ]);
    expect(ordered.metrics).toMatchObject({
      observerRequests: 1,
      scoutRequests: 1,
      refreshSatisfied: 1,
      refreshRejected: 2,
    });
    expect(Object.isFrozen(observer)).toBe(false);
    expect(Object.isFrozen(scout)).toBe(false);
  });

  it("returns one bounded freshness-qualified route view without computing strategy", () => {
    const segments = new FakeSegments();
    segments.reads.set("W2N1", ready(record("W2N1", 95, true), 2));
    segments.reads.set("W3N1", ready(record("W3N1", 80, false), 3));
    const service = new IntelService(segments);

    const result = service.plan({
      observerAuthorizations: [],
      queries: [],
      routeQueries: [
        {
          id: "route-a",
          roomNames: ["W2N1", "W3N1", "W4N1"],
          maximumAge: 10,
          expiresAfter: 50,
        },
      ],
      scoutAuthorizations: [],
      snapshot: emptyWorldSnapshot(100, "shard0"),
      snapshotRevision: "snapshot-100",
      visionDemands: [],
    });

    expect(result.routes).toEqual([
      {
        id: "route-a",
        status: "unavailable",
        freshness: "unknown",
        quality: "unknown",
        rooms: [
          expect.objectContaining({ roomName: "W2N1", freshness: "fresh" }),
          expect.objectContaining({ roomName: "W3N1", freshness: "stale" }),
          expect.objectContaining({ roomName: "W4N1", freshness: "unknown" }),
        ],
      },
    ]);
  });

  it("offers transient current vision when the prior segment generation is inactive", () => {
    const segments = new FakeSegments();
    segments.reads.set("W1N1", { status: "loading", reason: "activation-pending" });
    const service = new IntelService(segments);

    service.plan({
      observerAuthorizations: [],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: snapshot(101, [visibleRoom("W1N1", 101)]),
      snapshotRevision: "snapshot-101",
      visionDemands: [],
    });

    expect(segments.writes).toHaveLength(1);
    expect(segments.writes[0]?.key).toBe("W1N1");
    expect(segments.writes[0]?.value.observedAt).toBe(101);
  });

  it("repairs a future-dated generation from current observation", () => {
    const segments = new FakeSegments();
    segments.reads.set("W1N1", ready(record("W1N1", 102, true), 1));
    const service = new IntelService(segments);

    service.plan({
      observerAuthorizations: [],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: snapshot(101, [visibleRoom("W1N1", 101)]),
      snapshotRevision: "snapshot-101",
      visionDemands: [],
    });

    expect(segments.writes).toHaveLength(1);
    expect(segments.writes[0]?.value.observedAt).toBe(101);
  });

  it("offers a material ownership change before the unchanged-record rewrite interval", () => {
    const segments = new FakeSegments();
    segments.reads.set("W1N1", ready(record("W1N1", 100, true), 1));
    const service = new IntelService(segments);
    const current = visibleRoom("W1N1", 101);

    service.plan({
      observerAuthorizations: [],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: snapshot(101, [
        {
          ...current,
          controller: {
            id: "controller-a",
            level: 0,
            ownerUsername: null,
            ownership: "reserved",
            pos: { roomName: "W1N1", x: 25, y: 25 },
            progress: null,
            progressTotal: null,
            reservationTicksToEnd: 2_000,
            reservationUsername: "RemoteOwner",
            safeMode: null,
            safeModeAvailable: 0,
            safeModeCooldown: null,
            ticksToDowngrade: null,
            upgradeBlocked: null,
          },
        },
      ]),
      snapshotRevision: "snapshot-101",
      visionDemands: [],
    });

    expect(segments.writes).toHaveLength(1);
    expect(segments.writes[0]?.key).toBe("W1N1");
    expect(segments.writes[0]?.value.observedAt).toBe(101);
    expect(segments.writes[0]?.value.controller).toMatchObject({
      ownership: "reserved",
      reservationUsername: "RemoteOwner",
    });
  });

  it("rejects demand identities that cannot fit the derived observer request bound", () => {
    const segments = new FakeSegments();
    const service = new IntelService(segments);
    const oversized = {
      ...demand(
        "x".repeat(INTEL_SERVICE_LIMITS.maximumDemandIdCodeUnits + 1),
        "W1N1",
        "observer-auth",
        null,
      ),
    } satisfies VisionDemandV1;

    const result = service.plan({
      observerAuthorizations: [observerAuthorization("observer-auth", "intel")],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: emptyWorldSnapshot(100, "shard0"),
      snapshotRevision: "snapshot-100",
      visionDemands: [oversized],
    });

    expect(result.refresh.dispositions).toEqual([
      expect.objectContaining({ demandId: oversized.id, reason: "invalid-demand" }),
    ]);
    expect(result.refresh.observerRequests).toEqual([]);
  });

  it("rejects malformed priority objects instead of forwarding extra data", () => {
    const segments = new FakeSegments();
    const service = new IntelService(segments);
    const malformed = {
      ...demand("malformed", "W1N1", "observer-auth", null),
      priority: { class: "growth", value: 10, extra: "not-allowed" },
    } as unknown as VisionDemandV1;

    const result = service.plan({
      observerAuthorizations: [observerAuthorization("observer-auth", "intel")],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: emptyWorldSnapshot(100, "shard0"),
      snapshotRevision: "snapshot-100",
      visionDemands: [malformed],
    });

    expect(result.refresh.dispositions).toEqual([
      expect.objectContaining({ demandId: "malformed", reason: "invalid-demand" }),
    ]);
    expect(result.refresh.observerRequests).toEqual([]);
  });

  it("offers at most the fixed write budget and fails closed above batch caps", () => {
    const segments = new FakeSegments();
    const service = new IntelService(segments);
    const rooms = Array.from({ length: 5 }, (_, index) =>
      visibleRoom(`W${String(index + 1)}N1`, 101),
    );

    const result = service.plan({
      observerAuthorizations: [],
      queries: [],
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: snapshot(101, rooms.reverse()),
      snapshotRevision: "snapshot-101",
      visionDemands: [],
    });

    expect(segments.writes).toHaveLength(INTEL_SERVICE_LIMITS.maximumRoomWritesPerTick);
    expect(segments.writes.map(({ key }) => key)).toEqual(["W2N1", "W3N1"]);
    expect(result.metrics).toMatchObject({
      visibleRooms: 5,
      writeOffers: INTEL_SERVICE_LIMITS.maximumRoomWritesPerTick,
      writeRejected: 0,
    });

    const overCap = service.plan({
      observerAuthorizations: [],
      queries: Array.from({ length: INTEL_SERVICE_LIMITS.maximumQueriesPerTick + 1 }, (_, index) =>
        query(`W${String(index + 1)}N1`, 1, 2),
      ),
      routeQueries: [],
      scoutAuthorizations: [],
      snapshot: emptyWorldSnapshot(102, "shard0"),
      snapshotRevision: "snapshot-102",
      visionDemands: [],
    });
    expect(overCap.status).toBe("limit-exceeded");
    expect(overCap.rooms).toEqual([]);
  });
});

class FakeSegments implements SegmentService {
  readonly reads = new Map<string, SegmentReadResult<RoomIntelRecordV1>>();
  readonly writes: { readonly key: string; readonly value: RoomIntelRecordV1 }[] = [];

  register<Key, Value>(contract: SegmentStoreContract<Key, Value>): SegmentStore<Key, Value> {
    expect(contract).toMatchObject({
      id: "world.room-intel.v1",
      owner: "IntelService",
      priority: "active-colony-remote",
      schemaVersion: 1,
    });
    return {
      read: (key) =>
        (this.reads.get(String(key)) ?? { status: "missing" }) as SegmentReadResult<Value>,
      write: (key, value): SegmentWriteResult => {
        this.writes.push({ key: String(key), value: value as RoomIntelRecordV1 });
        return { accepted: true, status: "offered" };
      },
    };
  }
}

function query(roomName: string, maximumAge: number, expiresAfter: number) {
  return { roomName, maximumAge, expiresAfter };
}

function demand(
  id: string,
  targetRoomName: string,
  observerAuthorizationId: string | null,
  scoutAuthorizationId: string | null,
): VisionDemandV1 {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    issuer: "intel",
    requestedAt: 100,
    deadline: 110,
    targetRoomName,
    minimumObservationTick: 101,
    maximumIntelAge: 10,
    priority: { class: "growth", value: 10 },
    observerAuthorizationId,
    observerAuthorizationRevision: observerAuthorizationId === null ? null : 1,
    scoutAuthorizationId,
    scoutAuthorizationRevision: scoutAuthorizationId === null ? null : 1,
    snapshotRevision: "snapshot-100",
  };
}

function observerAuthorization(id: string, issuer: string): ObserverAuthorization {
  return { id, revision: 1, issuer, active: true, expiresAt: 110 };
}

function scoutAuthorization(id: string, issuer: string): VisionScoutAuthorization {
  return {
    id,
    revision: 1,
    issuer,
    active: true,
    expiresAt: 110,
    budgetId: "budget-scout",
    maximumEnergy: 50,
    maximumSpawnTicks: 3,
    maximumCpuMilli: 250,
  };
}

function ready(value: RoomIntelRecordV1, generation: number): SegmentReadResult<RoomIntelRecordV1> {
  return { status: "ready", value, generation };
}

function record(roomName: string, observedAt: number, complete: boolean): RoomIntelRecordV1 {
  return {
    schemaVersion: 1,
    shard: "shard0",
    roomName,
    observedAt,
    eventsObservedAt: complete ? Math.max(0, observedAt - 1) : null,
    complete,
    terrain: { cells: "0".repeat(2_500), revision: `terrain-${roomName}` },
    controller: null,
    mineral: null,
    mineralStatus: "complete",
    sources: [],
    sourceStatus: "complete",
    structures: [],
    structureStatus: complete ? "complete" : "unavailable",
    hostiles: [],
    hostileStatus: "complete",
    events: [],
    eventLogStatus: complete ? "observed" : "unavailable",
  };
}

function snapshot(tick: number, rooms: readonly RoomSnapshot[]): WorldSnapshot {
  const empty = emptyWorldSnapshot(tick, "shard0");
  return {
    ...empty,
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    rooms,
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: rooms.map(({ name, observedAt }) => ({
        age: 0,
        observedAt,
        roomName: name,
        status: "visible",
      })),
      scope: "current-tick",
    },
  };
}

function visibleRoom(name: string, observedAt: number): RoomSnapshot {
  return {
    constructionSites: [],
    controller: null,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    eventLogStatus: "observed",
    events: [],
    hostileCreeps: [],
    mineral: null,
    name,
    observedAt,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    structures: [],
    terrain: { cells: "0".repeat(2_500), revision: `terrain-${name}` },
  };
}
