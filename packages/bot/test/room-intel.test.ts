/// <reference types="screeps" />

import { describe, expect, it } from "vitest";
import { INTEL_LIMITS, createRoomIntelCodec, projectRoomIntelRecord } from "../src/world/intel";
import type { RoomSnapshot } from "../src/world/snapshot";

describe("room intelligence projection", () => {
  it("projects complete versioned facts deterministically across observation order", () => {
    const ordered = room();
    const reversed = {
      ...ordered,
      events: [...(ordered.events ?? [])].reverse(),
      hostileCreeps: [...ordered.hostileCreeps].reverse(),
      sources: [...ordered.sources].reverse(),
      structures: [...(ordered.structures ?? [])].reverse(),
    } satisfies RoomSnapshot;

    const first = projectRoomIntelRecord(ordered, "shard0");
    const second = projectRoomIntelRecord(reversed, "shard0");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      shard: "shard0",
      roomName: "W1N1",
      observedAt: 100,
      eventLogStatus: "observed",
      mineralStatus: "complete",
      complete: true,
      terrain: { revision: "terrain-a" },
      controller: {
        ownership: "reserved",
        reservationUsername: "RemoteOwner",
        reservationTicksToEnd: 1_000,
      },
      mineral: { mineralType: "H" },
    });
    expect(first?.sources.map(({ id }) => id)).toEqual(["source-a", "source-b"]);
    expect(first?.hostiles.map(({ id }) => id)).toEqual(["hostile-a", "hostile-b"]);
    expect(first?.structures.map(({ id }) => id)).toEqual(["core-a", "portal-a"]);
    expect(first?.structures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "core-a",
          structureType: "invaderCore",
          invaderCore: { level: 3, ticksToDeploy: 500 },
        }),
        expect.objectContaining({
          id: "portal-a",
          structureType: "portal",
          portal: { destinationRoomName: "E2S3", destinationShard: "shard1", x: 11, y: 12 },
        }),
      ]),
    );
    expect(first?.events).toEqual([
      {
        event: 1,
        objectId: "hostile-a",
        targetId: "spawn-a",
        amount: 250,
        attackType: 2,
        resourceType: null,
        structureType: null,
        x: null,
        y: null,
      },
      {
        event: 2,
        objectId: "old-road",
        targetId: null,
        amount: null,
        attackType: null,
        resourceType: null,
        structureType: "road",
        x: null,
        y: null,
      },
    ]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("fails closed to explicit partial quality when bounded facts overflow", () => {
    const input = room();
    const structures = Array.from(
      { length: INTEL_LIMITS.maximumStructuresPerRoom + 1 },
      (_, id) => ({
        hits: 1,
        hitsMax: 1,
        id: `structure-${String(id).padStart(3, "0")}`,
        ownerUsername: null,
        ownership: "unowned" as const,
        pos: { roomName: "W1N1", x: id % 50, y: Math.floor(id / 50) },
        structureType: "road",
        isPublic: null,
        ticksToDecay: 100,
      }),
    );

    const record = projectRoomIntelRecord({ ...input, structures }, "shard0");

    expect(record).toMatchObject({ complete: false, structureStatus: "limit-exceeded" });
    expect(record?.structures).toEqual([]);
  });

  it("marks unavailable mineral observation as partial rather than known absence", () => {
    const { mineral, ...withoutMineral } = room();
    expect(mineral).not.toBeUndefined();

    const record = projectRoomIntelRecord(withoutMineral, "shard0");

    expect(record).toMatchObject({ complete: false, mineral: null, mineralStatus: "unavailable" });
  });

  it("round-trips canonical V1 and rejects malformed, future, or corrupt-terrain payloads", () => {
    const codec = createRoomIntelCodec();
    const record = projectRoomIntelRecord(room(), "shard0");
    if (record === null) throw new Error("expected valid room record");

    const encoded = codec.encode(record);

    expect(codec.decode(encoded)).toEqual(record);
    expect(() => codec.decode(JSON.stringify({ ...record, roomName: "invalid" }))).toThrow();
    expect(() => codec.decode(JSON.stringify({ ...record, schemaVersion: 2 }))).toThrow();
    expect(() =>
      codec.decode(
        JSON.stringify({ ...record, terrain: { ...record.terrain, cells: "x".repeat(2_500) } }),
      ),
    ).toThrow();
    expect(() =>
      codec.decode(
        JSON.stringify({
          ...record,
          hostiles: record.hostiles.map((hostile, index) =>
            index === 0
              ? {
                  ...hostile,
                  body: {
                    ...hostile.body,
                    attack: { ...hostile.body.attack, total: hostile.body.size + 1 },
                  },
                }
              : hostile,
          ),
        }),
      ),
    ).toThrow();
  });
});

function room(): RoomSnapshot {
  return {
    constructionSites: [],
    controller: {
      id: "controller-a",
      level: 0,
      ownerUsername: null,
      ownership: "reserved",
      pos: { roomName: "W1N1", x: 25, y: 25 },
      progress: null,
      progressTotal: null,
      reservationTicksToEnd: 1_000,
      reservationUsername: "RemoteOwner",
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: null,
      upgradeBlocked: null,
    },
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    eventLogStatus: "observed",
    events: [
      {
        amount: null,
        attackType: null,
        event: 2,
        objectId: "old-road",
        resourceType: null,
        structureType: "road",
        targetId: null,
        x: null,
        y: null,
      },
      {
        amount: 250,
        attackType: 2,
        event: 1,
        objectId: "hostile-a",
        resourceType: null,
        structureType: null,
        targetId: "spawn-a",
        x: null,
        y: null,
      },
    ],
    hostileCreeps: [creep("hostile-b", "Other"), creep("hostile-a", "Enemy")],
    mineral: {
      amount: 10_000,
      density: 2,
      id: "mineral-a",
      mineralType: "H",
      pos: { roomName: "W1N1", x: 10, y: 10 },
      ticksToRegeneration: null,
    },
    name: "W1N1",
    observedAt: 100,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [
      {
        energy: 3_000,
        energyCapacity: 3_000,
        id: "source-b",
        pos: { roomName: "W1N1", x: 20, y: 20, sourceId: "source-b" },
        ticksToRegeneration: null,
      },
      {
        energy: 3_000,
        energyCapacity: 3_000,
        id: "source-a",
        pos: { roomName: "W1N1", x: 10, y: 20, sourceId: "source-a" },
        ticksToRegeneration: 50,
      },
    ],
    storedStructures: [],
    structures: [
      {
        hits: 1,
        hitsMax: 1,
        id: "portal-a",
        ownerUsername: null,
        ownership: "unowned",
        portal: {
          destinationRoomName: "E2S3",
          destinationShard: "shard1",
          x: 11,
          y: 12,
        },
        pos: { roomName: "W1N1", x: 5, y: 5 },
        structureType: "portal",
        ticksToDecay: 1_000,
      },
      {
        hits: 100_000,
        hitsMax: 100_000,
        id: "core-a",
        invaderCore: { level: 3, ticksToDeploy: 500 },
        ownerUsername: "Invader",
        ownership: "foreign",
        pos: { roomName: "W1N1", x: 25, y: 25 },
        structureType: "invaderCore",
        ticksToDecay: null,
      },
    ],
    terrain: { cells: "0".repeat(2_500), revision: "terrain-a" },
  };
}

function creep(id: string, ownerUsername: string): RoomSnapshot["hostileCreeps"][number] {
  const part = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: id === "hostile-a" ? 2 : 1,
      attack: id === "hostile-a" ? { active: 1, boosted: 0, total: 1 } : part,
      carry: part,
      claim: part,
      heal: part,
      move: { active: 1, boosted: 0, total: 1 },
      rangedAttack: part,
      size: id === "hostile-a" ? 2 : 1,
      tough: part,
      work: part,
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id,
    name: id,
    ownerUsername,
    pos: { roomName: "W1N1", x: 20, y: 20 },
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
}
