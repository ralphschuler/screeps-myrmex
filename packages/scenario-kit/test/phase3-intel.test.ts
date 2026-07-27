/// <reference types="screeps" />

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTEL_SERVICE_LIMITS,
  IntelService,
  type IntelServiceMetrics,
  type RoomIntelQueryResult,
  type VisionDemandV1,
  type VisionScoutAuthorization,
} from "../../bot/src/world/intel";
import type { ObserverAuthorization } from "../../bot/src/observer";
import {
  SEGMENT_MANAGER_LIMITS,
  SegmentManager,
  type SegmentManagerMetrics,
  type SegmentOwnerStateV1,
} from "../../bot/src/segments";
import {
  emptyWorldSnapshot,
  type CreepSnapshot,
  type RoomSnapshot,
  type WorldSnapshot,
} from "../../bot/src/world/snapshot";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

interface IntelWorld {
  readonly owner: SegmentOwnerStateV1 | Record<string, never>;
  readonly data: readonly (readonly [number, string])[];
  readonly active: readonly number[];
}

interface IntelInput {
  readonly visibleRoomNames: readonly string[];
  readonly queryRoomName: string | null;
  readonly refresh: boolean;
  readonly corruptRoomName: string | null;
  readonly reservedOwner: boolean;
  readonly reverse: boolean;
}

interface IntelOutcome {
  readonly query: Pick<RoomIntelQueryResult, "freshness" | "quality" | "reason"> | null;
  readonly intel: IntelServiceMetrics;
  readonly segments: SegmentManagerMetrics;
  readonly observerRequests: number;
  readonly scoutRequests: number;
  readonly reservationUsername: string | null;
  readonly entries: number;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 3 room intelligence deterministic outcome", () => {
  it("recovers vision, corruption, ownership change, reset, and segment eviction deterministically", () => {
    const warm = runScenario(intelScenario(false, false));
    const resetReordered = runScenario(intelScenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);

    expect(warm.outcomes[6]?.query).toEqual({
      freshness: "fresh",
      quality: "complete",
      reason: "segment-ready",
    });
    expect(warm.outcomes[7]?.query).toEqual({
      freshness: "unknown",
      quality: "unknown",
      reason: "segment-corrupt",
    });
    expect(warm.outcomes[7]).toMatchObject({ observerRequests: 1, scoutRequests: 1 });
    expect(warm.outcomes[8]?.query).toEqual({
      freshness: "current",
      quality: "complete",
      reason: "current-observation",
    });
    expect(warm.outcomes.some(({ segments }) => segments.evictions > 0)).toBe(true);
    expect(warm.outcomes[warm.outcomes.length - 1]).toMatchObject({
      query: { freshness: "fresh", quality: "complete", reason: "segment-ready" },
      reservationUsername: "RemoteOwner",
    });

    for (const outcome of warm.outcomes) {
      expect(outcome.entries).toBeLessThanOrEqual(SEGMENT_MANAGER_LIMITS.maximumEntries);
      expect(outcome.segments.activatedSegments).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumActiveSegments,
      );
      expect(outcome.segments.readCodeUnits).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumReadCodeUnitsPerTick,
      );
      expect(outcome.segments.writeCodeUnits).toBeLessThanOrEqual(
        SEGMENT_MANAGER_LIMITS.maximumWriteCodeUnitsPerTick,
      );
      expect(outcome.intel.writeOffers).toBeLessThanOrEqual(
        INTEL_SERVICE_LIMITS.maximumRoomWritesPerTick,
      );
      expect(outcome.intel.queried).toBeLessThanOrEqual(INTEL_SERVICE_LIMITS.maximumQueriesPerTick);
    }
  }, 15_000);
});

function intelScenario(
  reset: boolean,
  reverse: boolean,
): ReplayScenario<IntelWorld, IntelInput, IntelOutcome> {
  const initialTicks = Array.from({ length: 6 }, () =>
    input(["W1N1"], null, false, null, false, reverse),
  );
  const pressureRooms = Array.from({ length: 33 }, (_, index) => `W${String(index + 1)}N1`);
  const inputs: readonly IntelInput[] = [
    ...initialTicks,
    input([], "W1N1", false, null, false, reverse),
    input([], "W1N1", true, "W1N1", false, reverse),
    input(["W1N1"], "W1N1", false, null, true, reverse),
    ...Array.from({ length: 40 }, () => input(pressureRooms, null, false, null, true, reverse)),
    input([], "W1N1", false, null, true, reverse),
    input([], "W1N1", false, null, true, reverse),
  ];

  return defineReplayScenario<IntelWorld, IntelInput, IntelOutcome>({
    id: "phase3/intel/segment-freshness-recovery",
    seed: "phase3-intel-v1",
    initialWorld: { owner: {}, data: [], active: [] },
    ticks: inputs.map((tickInput, index) => ({
      gameTime: 1_000 + index,
      cpuBudget: 1,
      resetHeap: reset && [3, 8, 21, 34, 47].includes(index),
      input: tickInput,
    })),
    step({ gameTime, input: tickInput, world }) {
      const data = new Map(world.data);
      if (tickInput.corruptRoomName !== null) {
        const current = currentReference(world.owner, tickInput.corruptRoomName);
        if (current !== null) data.set(current.segmentId, "corrupt");
      }
      let nextActive: readonly number[] = [];
      const raw = {
        segments: Object.fromEntries(world.active.map((id) => [id, data.get(id) ?? ""])) as Record<
          number,
          string
        >,
        setActiveSegments(ids: number[]) {
          nextActive = Object.freeze([...ids]);
        },
      };
      vi.stubGlobal("RawMemory", raw);
      const opened = SegmentManager.open(world.owner, gameTime);
      if (opened.status === "unsupported") throw new Error("unexpected future segment owner");
      const manager = opened.manager;
      manager.beginTick();
      const service = new IntelService(manager);
      const snapshot = makeSnapshot(gameTime, tickInput);
      const observerAuthorizations: readonly ObserverAuthorization[] = tickInput.refresh
        ? [
            {
              id: "observer-auth",
              revision: 1,
              issuer: "phase3-intel",
              active: true,
              expiresAt: gameTime + 10,
            },
          ]
        : [];
      const scoutAuthorizations: readonly VisionScoutAuthorization[] = tickInput.refresh
        ? [
            {
              id: "scout-auth",
              revision: 1,
              issuer: "phase3-intel",
              active: true,
              expiresAt: gameTime + 10,
              budgetId: "colony-budget/scout",
              maximumEnergy: 50,
              maximumSpawnTicks: 3,
              maximumCpuMilli: 250,
            },
          ]
        : [];
      const visionDemands = tickInput.refresh
        ? [
            demand(gameTime, "observer-refresh", "W1N1", "observer-auth", null),
            demand(gameTime, "scout-refresh", "W2N2", null, "scout-auth"),
          ]
        : [];
      const result = service.plan({
        observerAuthorizations,
        queries:
          tickInput.queryRoomName === null
            ? []
            : [{ roomName: tickInput.queryRoomName, maximumAge: 50, expiresAfter: 100 }],
        routeQueries: [],
        scoutAuthorizations,
        snapshot,
        snapshotRevision: revision(snapshot),
        visionDemands,
      });
      const segments = manager.reconcile();
      for (const [id, value] of Object.entries(raw.segments)) data.set(Number(id), value);
      const owner = manager.view();
      const query = result.rooms[0];
      return {
        nextWorld: {
          owner,
          data: [...data.entries()].sort(([left], [right]) => left - right),
          active: nextActive,
        },
        outcome: {
          query:
            query === undefined
              ? null
              : { freshness: query.freshness, quality: query.quality, reason: query.reason },
          intel: result.metrics,
          segments,
          observerRequests: result.refresh.observerRequests.length,
          scoutRequests: result.refresh.scoutRequests.length,
          reservationUsername: query?.record?.controller?.reservationUsername ?? null,
          entries: owner.entries.length,
        },
        cpuUsed: 0.5,
      };
    },
    verify({ finalWorld, outcomes }) {
      if (outcomes.length !== inputs.length) throw new Error("intel outcome count mismatch");
      if (!("schemaVersion" in finalWorld.owner))
        throw new Error("intel owner was not initialized");
      if ((finalWorld.owner as SegmentOwnerStateV1).entries.length === 0) {
        throw new Error("intel records were not retained");
      }
    },
  });
}

function makeSnapshot(tick: number, input: IntelInput): WorldSnapshot {
  const roomNames = input.reverse ? [...input.visibleRoomNames].reverse() : input.visibleRoomNames;
  const rooms = roomNames.map((roomName) =>
    room(roomName, tick, input.reservedOwner, input.reverse),
  );
  const empty = emptyWorldSnapshot(tick, "shard0");
  return {
    ...empty,
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    rooms,
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: rooms
        .map(({ name, observedAt }) => ({
          age: 0 as const,
          observedAt,
          roomName: name,
          status: "visible" as const,
        }))
        .sort((a, b) => a.roomName.localeCompare(b.roomName)),
      scope: "current-tick",
    },
  };
}

function room(name: string, tick: number, reservedOwner: boolean, reverse: boolean): RoomSnapshot {
  const events = [
    {
      event: 2,
      objectId: "road-old",
      targetId: null,
      amount: null,
      attackType: null,
      resourceType: null,
      structureType: "road",
      x: null,
      y: null,
    },
    {
      event: 1,
      objectId: "hostile-a",
      targetId: "container-a",
      amount: 50,
      attackType: 1,
      resourceType: null,
      structureType: null,
      x: null,
      y: null,
    },
  ];
  const sources = [
    {
      energy: 3_000,
      energyCapacity: 3_000,
      id: `${name}-source-b`,
      pos: { roomName: name, sourceId: `${name}-source-b`, x: 30, y: 20 },
      ticksToRegeneration: null,
    },
    {
      energy: 3_000,
      energyCapacity: 3_000,
      id: `${name}-source-a`,
      pos: { roomName: name, sourceId: `${name}-source-a`, x: 10, y: 20 },
      ticksToRegeneration: null,
    },
  ];
  const hostiles = name === "W1N1" && !reservedOwner ? [hostile(name)] : [];
  return {
    constructionSites: [],
    controller: {
      id: `${name}-controller`,
      level: 0,
      ownerUsername: null,
      ownership: reservedOwner ? "reserved" : "neutral",
      pos: { roomName: name, x: 25, y: 25 },
      progress: null,
      progressTotal: null,
      reservationTicksToEnd: reservedOwner ? 2_000 : null,
      reservationUsername: reservedOwner ? "RemoteOwner" : null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: null,
      upgradeBlocked: null,
    },
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    events: reverse ? [...events].reverse() : events,
    eventLogStatus: "observed",
    hostileCreeps: hostiles,
    mineral: null,
    name,
    observedAt: tick,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: reverse ? [...sources].reverse() : sources,
    storedStructures: [],
    structures: [],
    terrain: { cells: "0".repeat(2_500), revision: `terrain-${name}` },
  };
}

function hostile(roomName: string): CreepSnapshot {
  const none = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 2,
      attack: { active: 1, boosted: 0, total: 1 },
      carry: none,
      claim: none,
      heal: none,
      move: { active: 1, boosted: 0, total: 1 },
      rangedAttack: none,
      size: 2,
      tough: none,
      work: none,
    },
    fatigue: 0,
    hits: 200,
    hitsMax: 200,
    id: "hostile-a",
    name: "hostile-a",
    ownerUsername: "Enemy",
    pos: { roomName, x: 20, y: 20 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
}

function demand(
  tick: number,
  id: string,
  targetRoomName: string,
  observer: string | null,
  scout: string | null,
): VisionDemandV1 {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    issuer: "phase3-intel",
    requestedAt: tick,
    deadline: tick + 10,
    targetRoomName,
    minimumObservationTick: tick,
    maximumIntelAge: 5,
    priority: { class: "growth", value: 25 },
    observerAuthorizationId: observer,
    observerAuthorizationRevision: observer === null ? null : 1,
    scoutAuthorizationId: scout,
    scoutAuthorizationRevision: scout === null ? null : 1,
    snapshotRevision: `shard0:${String(tick)}:0`,
  };
}

function revision(snapshot: WorldSnapshot): string {
  return `${snapshot.observation.shard}:${String(snapshot.observation.tick)}:0`;
}

function input(
  visibleRoomNames: readonly string[],
  queryRoomName: string | null,
  refresh: boolean,
  corruptRoomName: string | null,
  reservedOwner: boolean,
  reverse: boolean,
): IntelInput {
  return { visibleRoomNames, queryRoomName, refresh, corruptRoomName, reservedOwner, reverse };
}

function currentReference(owner: SegmentOwnerStateV1 | Record<string, never>, roomName: string) {
  return "schemaVersion" in owner
    ? ((owner as SegmentOwnerStateV1).entries.find(({ key }) => key === roomName)?.current ?? null)
    : null;
}
