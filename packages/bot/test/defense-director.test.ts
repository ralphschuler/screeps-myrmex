import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { planDefense } from "../src/defense";
import { freezeWorldSnapshot, type WorldSnapshot } from "../src/world/snapshot";

describe("DefenseDirector", () => {
  it("never targets configured allies or NAPs and deterministically focuses an eligible hostile", () => {
    const intents = planDefense(
      snapshot({
        hostiles: [
          creep("ally", "Friendly", 9),
          creep("nap", "Pact", 8),
          creep("enemy", "Enemy", 1),
        ],
      }),
      buildRuntimeConfig({ relations: { allies: ["Friendly"], naps: ["Pact"] } }),
    );
    expect(intents.filter(({ kind }) => kind === "tower.attack")).toEqual([
      expect.objectContaining({ target: "enemy" }),
    ]);
  });

  it("heals a critically injured owned creep before attacking and never spends a reserve-gated repair", () => {
    const intents = planDefense(
      snapshot({ hostiles: [creep("enemy", "Enemy", 5)], injured: true, towerEnergy: 400 }),
      buildRuntimeConfig(),
    );
    expect(intents.filter(({ kind }) => kind.startsWith("tower."))).toEqual([
      expect.objectContaining({ kind: "tower.heal", target: "worker" }),
    ]);
  });

  it("requests safe mode only for a legal, predicted critical-asset loss", () => {
    const qualified = planDefense(
      snapshot({ hostiles: [creep("enemy", "Enemy", 5)], damagedSpawn: true }),
      buildRuntimeConfig(),
    );
    expect(qualified).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "safe-mode" })]),
    );
    expect(
      planDefense(
        snapshot({
          hostiles: [creep("enemy", "Enemy", 5)],
          damagedSpawn: true,
          safeModeAvailable: 0,
        }),
        buildRuntimeConfig(),
      ),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "safe-mode" })]));
  });
});

function snapshot(
  options: {
    readonly hostiles?: readonly ReturnType<typeof creep>[];
    readonly injured?: boolean;
    readonly towerEnergy?: number;
    readonly damagedSpawn?: boolean;
    readonly safeModeAvailable?: number;
  } = {},
): WorldSnapshot {
  const roomName = "W1N1";
  const store = (energy: number) => ({
    capacity: 1_000,
    freeCapacity: 1_000 - energy,
    resources: [{ resourceType: "energy", amount: energy }],
    usedCapacity: energy,
  });
  const room = {
    name: roomName,
    observedAt: 100,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    controller: {
      id: "controller",
      level: 3,
      ownerUsername: "Myrmex",
      ownership: "owned" as const,
      pos: pos(roomName),
      progress: 0,
      progressTotal: 1,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: options.safeModeAvailable ?? 1,
      safeModeCooldown: null,
      ticksToDowngrade: 10_000,
      upgradeBlocked: null,
    },
    hostileCreeps: options.hostiles ?? [],
    ownedCreeps: options.injured
      ? [{ ...creep("worker", "Myrmex", 0), hits: 10, hitsMax: 100 }]
      : [],
    ownedExtensions: [],
    ownedSpawns: [
      {
        active: true,
        id: "spawn",
        name: "Spawn1",
        pos: pos(roomName),
        hits: options.damagedSpawn ? 50 : 5_000,
        hitsMax: 5_000,
        spawning: null,
        store: store(300),
      },
    ],
    ownedTowers: [
      {
        id: "tower",
        pos: pos(roomName),
        hits: 3_000,
        hitsMax: 3_000,
        store: store(options.towerEnergy ?? 800),
      },
    ],
    constructionSites: [],
    droppedResources: [],
    ruins: [],
    sources: [],
    storedStructures: [],
    tombstones: [],
  };
  return freezeWorldSnapshot({
    schemaVersion: 1,
    observation: { age: 0, shard: "shard3", status: "observed", tick: 100 },
    observedAt: 100,
    ownedConstructionSiteCount: 0,
    rooms: [room],
    ownedRooms: [room],
    visibility: {
      absentRoomSemantics: "unknown",
      scope: "current-tick",
      rooms: [{ roomName, status: "visible", observedAt: 100, age: 0 }],
    },
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: room.hostileCreeps.length,
        ownedCreeps: room.ownedCreeps.length,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 1,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 0,
        tombstones: 0,
        total: 3 + room.hostileCreeps.length + room.ownedCreeps.length,
      },
      estimatedPayloadBytes: 0,
    },
  });
}

function creep(id: string, ownerUsername: string, attack: number) {
  const part = (active: number) => ({ active, boosted: 0, total: active });
  return {
    id,
    name: id,
    ownerUsername,
    pos: pos("W1N1"),
    body: {
      activeParts: attack,
      size: attack,
      attack: part(attack),
      carry: part(0),
      claim: part(0),
      heal: part(0),
      move: part(attack),
      rangedAttack: part(0),
      tough: part(0),
      work: part(0),
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
}

function pos(roomName: string) {
  return { roomName, x: 25, y: 25 };
}
