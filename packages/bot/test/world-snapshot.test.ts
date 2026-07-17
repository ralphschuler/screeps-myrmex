import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeGame } from "../src/runtime/context";
import { observeWorld } from "../src/world/observe";
import { emptyWorldSnapshot, freezeWorldSnapshot, utf8ByteLength } from "../src/world/snapshot";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const FIND_MINERALS_VALUE = 116;

class LivePosition {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(): number {
    return 0;
  }
}

describe("WorldSnapshot", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
    vi.stubGlobal("FIND_MINERALS", FIND_MINERALS_VALUE);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("is byte-equivalent when Game and Room collections have different insertion orders", () => {
    const forward = observeWorld(makeGame(false), { requestedRoomNames: ["W9N9", "W1N1"] });
    const reversed = observeWorld(makeGame(true), { requestedRoomNames: ["W1N1", "W9N9"] });

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.rooms.map((room) => room.name)).toEqual(["W1N1", "W2N2"]);
    expect(forward.rooms[0]?.sources.map((source) => source.id)).toEqual(["source-a", "source-b"]);
    expect(forward.rooms[0]?.storedStructures.map((structure) => structure.id)).toEqual([
      "container-a",
      "extension-a",
      "factory-i",
      "lab-h",
      "link-d",
      "nuker-l",
      "power-spawn-j",
      "spawn-b",
      "storage-e",
      "terminal-f",
      "tower-c",
    ]);
    expect(forward.rooms[0]?.sources[0]?.pos.sourceId).toBe("source-a");
    const container = forward.rooms[0]?.storedStructures.find(({ id }) => id === "container-a");
    expect(container?.hits).toBe(250_000);
    expect(container?.store.usedCapacity).toBe(1_100);
    expect(container?.ticksToDecay).toBe(87);
    expect(forward.rooms[0]?.ownedSpawns[0]?.store.resources).toEqual([
      { amount: 200, resourceType: "energy" },
      { amount: 3, resourceType: "power" },
    ]);
    expect(forward.rooms[0]?.ownedSpawns[0]?.active).toBe(true);
    expect(forward.rooms[0]?.ownedExtensions[0]?.active).toBe(true);
    const ownedLink = forward.rooms[0]?.ownedLinks?.[0];
    expect(ownedLink).toMatchObject({ active: true, cooldown: 3, id: "link-d" });
    expect(ownedLink?.store.usedCapacity).toBe(400);
    expect(forward.rooms[0]?.mineral).toMatchObject({
      amount: 12_000,
      density: 2,
      id: "mineral-a",
      ticksToRegeneration: 321,
    });
    expect(forward.rooms[0]?.ownedExtractors?.[0]).toMatchObject({
      active: true,
      cooldown: 2,
      id: "extractor-g",
    });
    expect(forward.rooms[0]?.ownedStorages?.[0]).toMatchObject({ active: true, id: "storage-e" });
    expect(forward.rooms[0]?.ownedTerminals?.[0]).toMatchObject({
      active: true,
      cooldown: 4,
      id: "terminal-f",
    });
    expect(forward.rooms[0]?.ownedLabs?.[0]).toMatchObject({
      active: true,
      cooldown: 6,
      energy: 1_200,
      energyCapacity: 2_000,
      id: "lab-h",
      mineralAmount: 500,
      mineralCapacity: 3_000,
      mineralType: "UH",
    });
    expect(forward.rooms[0]?.ownedFactories?.[0]).toMatchObject({
      active: true,
      cooldown: 12,
      id: "factory-i",
      level: 2,
    });
    expect(forward.rooms[0]?.ownedPowerSpawns?.[0]).toMatchObject({
      active: true,
      id: "power-spawn-j",
    });
    expect(forward.rooms[0]?.ownedObservers?.[0]).toMatchObject({
      active: true,
      id: "observer-k",
    });
    expect(forward.rooms[0]?.ownedNukers?.[0]).toMatchObject({
      active: true,
      cooldown: 45,
      id: "nuker-l",
    });
    expect(forward.rooms[0]?.hostileCreeps[0]?.boosts).toEqual([
      { bodyPart: "attack", compound: "UH", count: 2 },
    ]);
    expect(forward.stats.entities.total).toBe(21);

    const payload = {
      observation: forward.observation,
      observedAt: forward.observedAt,
      ownedConstructionSiteCount: forward.ownedConstructionSiteCount,
      ownedRooms: forward.ownedRooms,
      rooms: forward.rooms,
      schemaVersion: forward.schemaVersion,
      visibility: forward.visibility,
    };
    expect(forward.stats.estimatedPayloadBytes).toBe(utf8ByteLength(JSON.stringify(payload)));
    expect(forward.ownedConstructionSiteCount).toBe(1);
    expect(forward.rooms[0]?.structures?.map((structure) => structure.structureType)).toEqual(
      expect.arrayContaining(["constructedWall", "rampart"]),
    );
  });

  it("distinguishes confirmed visible absence from unknown rooms without stale data", () => {
    const snapshot = observeWorld(makeGame(false), {
      requestedRoomNames: ["W2N2", "W8N8", "W8N8"],
    });
    const neutralRoom = snapshot.rooms.find((room) => room.name === "W2N2");

    expect(neutralRoom?.controller).toBeNull();
    expect(snapshot.visibility).toEqual({
      absentRoomSemantics: "unknown",
      rooms: [
        { age: 0, observedAt: 500, roomName: "W1N1", status: "visible" },
        { age: 0, observedAt: 500, roomName: "W2N2", status: "visible" },
        { age: null, observedAt: null, roomName: "W8N8", status: "unknown" },
      ],
      scope: "current-tick",
    });

    const noVision = observeWorld(makeGameWithRooms({}), {
      requestedRoomNames: ["W1N1"],
    });
    expect(noVision.rooms).toEqual([]);
    expect(noVision.ownedRooms).toEqual([]);
    expect(noVision.visibility.rooms).toEqual([
      { age: null, observedAt: null, roomName: "W1N1", status: "unknown" },
    ]);

    const visibleAfterCreepsVanish = observeWorld(
      makeGameWithRooms({
        W1N1: withoutFindResults(makeOwnedRoom(false).room, FIND_CREEPS_VALUE),
      }),
      { requestedRoomNames: ["W1N1"] },
    );
    expect(visibleAfterCreepsVanish.rooms[0]?.hostileCreeps).toEqual([]);
    expect(visibleAfterCreepsVanish.rooms[0]?.ownedCreeps).toEqual([]);
    expect(visibleAfterCreepsVanish.visibility.rooms[0]?.status).toBe("visible");
  });

  it("copies live values into deeply immutable plain data", () => {
    const fixture = makeOwnedRoom(false);
    const snapshot = observeWorld(makeGameWithRooms({ W1N1: fixture.room }));
    const room = snapshot.rooms[0];

    expect(room).toBeDefined();
    assertPlainAndFrozen(snapshot);

    expect(() => {
      (room as unknown as { name: string }).name = "mutated";
    }).toThrow(TypeError);
    expect(() => {
      (room?.sources as unknown as unknown[]).push({});
    }).toThrow(TypeError);

    fixture.sourcePosition.x = 49;
    fixture.spawnStore.energy = 0;
    expect(room?.sources[0]?.pos.x).toBe(10);
    expect(room?.ownedSpawns[0]?.store.resources).toContainEqual({
      amount: 200,
      resourceType: "energy",
    });
  });

  it("observes compact static traversal without retaining live terrain or creep occupancy", () => {
    const fixture = makeOwnedRoom(false);
    let wallAtOrigin = true;
    const room = {
      ...(fixture.room as unknown as Record<string, unknown>),
      getTerrain: () => ({
        get: (x: number, y: number) => (wallAtOrigin && x === 0 && y === 0 ? 1 : 0),
      }),
    } as unknown as Room;

    const first = observeWorld(makeGameWithRooms({ W1N1: room }));
    const traversal = first.rooms[0]?.traversal;
    expect(traversal?.walkability).toHaveLength(2_500);
    expect(traversal?.walkability.charAt(0)).toBe("#");
    expect(traversal?.walkability.charAt(11 + 11 * 50)).toBe("."); // container
    expect(traversal?.walkability.charAt(23 + 25 * 50)).toBe("#"); // spawn
    expect(traversal?.walkability.charAt(26 + 25 * 50)).toBe("#"); // extension site

    wallAtOrigin = false;
    const changed = observeWorld(makeGameWithRooms({ W1N1: room }));
    expect(changed.rooms[0]?.traversal?.revision).not.toBe(traversal?.revision);
    expect(changed.rooms[0]?.traversal?.walkability.charAt(0)).toBe(".");
  });

  it("reduces body data to a fixed-width, 50-part-bounded survival capability summary", () => {
    const room = makeOwnedRoom(false, 60).room;
    const snapshot = observeWorld(makeGameWithRooms({ W1N1: room }));
    const hostileBody = snapshot.rooms[0]?.hostileCreeps[0]?.body;

    expect(hostileBody).toMatchObject({
      activeParts: 49,
      attack: { active: 25, boosted: 25, total: 25 },
      heal: { active: 24, boosted: 0, total: 25 },
      size: 50,
    });
    expect(snapshot.rooms[0]?.hostileCreeps[0]?.boosts).toEqual([
      { bodyPart: "attack", compound: "UH", count: 25 },
    ]);
    expect(Object.keys(hostileBody ?? {})).toEqual([
      "activeParts",
      "attack",
      "carry",
      "claim",
      "heal",
      "move",
      "rangedAttack",
      "size",
      "tough",
      "work",
    ]);
  });

  it("uses Game.creeps as the canonical owned-actor inventory", () => {
    const fixture = makeOwnedRoom(false);
    const liveCreeps = fixture.room.find(FIND_CREEPS_VALUE);
    const worker = liveCreeps.find((creep) => creep.my);
    if (worker === undefined) {
      throw new Error("owned worker fixture is unavailable");
    }
    const hostilesOnly = {
      ...(fixture.room as unknown as Record<string, unknown>),
      find: (findType: number): unknown[] =>
        findType === FIND_CREEPS_VALUE
          ? liveCreeps.filter((creep) => !creep.my)
          : fixture.room.find(findType as FindConstant),
    } as unknown as Room;
    const base = makeGameWithRooms({ W1N1: hostilesOnly });
    const snapshot = observeWorld({ ...base, creeps: { [worker.name]: worker } });

    expect(snapshot.rooms[0]?.ownedCreeps.map(({ id }) => id)).toEqual(["creep-b"]);
    expect(snapshot.rooms[0]?.hostileCreeps.map(({ id }) => id)).toEqual(["creep-a"]);
  });

  it.each([
    ["name key mismatch", "Game.creeps key does not match"],
    ["non-owned entry", "not owned"],
    ["duplicate ID", "duplicate owned creep id"],
    ["invisible room", "outside the visible room set"],
  ] as const)("fails closed on a %s in canonical Game.creeps", (variant, message) => {
    const base = makeGame(false);
    const worker = base.creeps["worker-1"];
    const room = base.rooms.W1N1;
    if (worker === undefined || room === undefined) {
      throw new Error("owned worker fixture is unavailable");
    }
    const hostiles = room.find(FIND_CREEPS_VALUE).filter((creep) => !creep.my);
    const hostile = hostiles[0];
    let creeps: Readonly<Record<string, Creep>>;
    if (variant === "name key mismatch") {
      creeps = { wrong: worker };
    } else if (variant === "non-owned entry") {
      if (hostile === undefined) {
        throw new Error("hostile fixture is unavailable");
      }
      creeps = { [hostile.name]: hostile };
    } else if (variant === "duplicate ID") {
      const duplicate = creepVariant(worker, { name: "worker-duplicate" });
      creeps = { [worker.name]: worker, [duplicate.name]: duplicate };
    } else {
      const invisible = creepVariant(worker, {
        pos: new LivePosition(worker.pos.x, worker.pos.y, "W9N9"),
      });
      creeps = { [invisible.name]: invisible };
    }

    expect(() => observeWorld({ ...base, creeps })).toThrow(message);
  });

  it("produces the same result from fresh objects after a simulated heap reset", () => {
    const beforeReset = JSON.stringify(observeWorld(makeGame(false)));
    const afterReset = JSON.stringify(observeWorld(makeGame(false)));

    expect(afterReset).toBe(beforeReset);
  });

  it("marks bootstrap snapshots as empty rather than current observations", () => {
    const snapshot = emptyWorldSnapshot(17, "shard3");

    expect(snapshot.observation).toEqual({
      age: null,
      shard: "shard3",
      status: "empty",
      tick: 17,
    });
    expect(snapshot.visibility.absentRoomSemantics).toBe("unknown");
    assertPlainAndFrozen(snapshot);
  });

  it("freezes nested data even when a caller supplies a shallow-frozen root", () => {
    const mutableChild = { value: 1 };
    const shallow = Object.freeze({ child: mutableChild });

    freezeWorldSnapshot(shallow as never);

    expect(Object.isFrozen(mutableChild)).toBe(true);
  });
});

function makeGame(reversed: boolean): RuntimeGame {
  const first = makeOwnedRoom(reversed).room;
  const second = makeNeutralRoom(reversed);
  const rooms = reversed ? { W2N2: second, W1N1: first } : { W1N1: first, W2N2: second };

  return makeGameWithRooms(rooms);
}

function makeGameWithRooms(rooms: Readonly<Record<string, Room>>): RuntimeGame {
  const creeps = Object.fromEntries(
    Object.values(rooms)
      .flatMap((room) => room.find(FIND_CREEPS_VALUE))
      .filter((creep) => creep.my)
      .map((creep) => [creep.name, creep]),
  );
  return {
    cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps,
    constructionSites: Object.fromEntries(
      Object.values(rooms)
        .flatMap((room) => room.find(FIND_CONSTRUCTION_SITES_VALUE))
        .map((site) => [String(site.id), site]),
    ),
    rooms,
    shard: { name: "shard3" },
    time: 500,
  };
}

function makeOwnedRoom(
  reversed: boolean,
  hostileBodySize = 3,
): {
  readonly room: Room;
  readonly sourcePosition: LivePosition;
  readonly spawnStore: Record<string, number>;
} {
  const sourcePosition = new LivePosition(10, 11, "W1N1");
  const spawnStore = reversed ? { power: 3, energy: 200 } : { energy: 200, power: 3 };
  const liveSpawnStore = makeStore(spawnStore, 300);
  const sources = [
    {
      energy: 2_000,
      energyCapacity: 3_000,
      id: "source-b",
      pos: new LivePosition(20, 21, "W1N1"),
      ticksToRegeneration: 20,
    },
    {
      energy: 1_500,
      energyCapacity: 3_000,
      id: "source-a",
      pos: sourcePosition,
      ticksToRegeneration: 10,
    },
  ];
  const structures = [
    {
      hits: 1_000,
      hitsMax: 1_000_000,
      id: "wall-a",
      pos: new LivePosition(30, 30, "W1N1"),
      structureType: "constructedWall",
    },
    {
      hits: 1_000,
      hitsMax: 1_000_000,
      id: "rampart-a",
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(23, 25, "W1N1"),
      structureType: "rampart",
    },
    {
      cooldown: 3,
      hits: 1_000,
      hitsMax: 1_000,
      id: "link-d",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(12, 11, "W1N1"),
      store: makeStore({ energy: 400 }, 800),
      structureType: "link",
    },
    {
      hits: 5_000,
      hitsMax: 5_000,
      id: "tower-c",
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(25, 25, "W1N1"),
      store: makeStore({ energy: 800 }, 1_000),
      structureType: "tower",
    },
    {
      hits: 5_000,
      hitsMax: 5_000,
      id: "extension-a",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(24, 25, "W1N1"),
      store: makeStore({ energy: 50 }, 50),
      structureType: "extension",
    },
    {
      hits: 5_000,
      hitsMax: 5_000,
      id: "spawn-b",
      my: true,
      name: "Spawn1",
      owner: { username: "Myrmex" },
      pos: new LivePosition(23, 25, "W1N1"),
      isActive: () => true,
      spawning: null,
      store: liveSpawnStore,
      structureType: "spawn",
    },
    {
      hits: 250_000,
      hitsMax: 250_000,
      id: "container-a",
      pos: new LivePosition(11, 11, "W1N1"),
      store: makeStore({ energy: 1_100 }, 2_000),
      structureType: "container",
      ticksToDecay: 87,
    },
    {
      hits: 10_000,
      hitsMax: 10_000,
      id: "storage-e",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(20, 25, "W1N1"),
      store: makeStore({ energy: 50_000, H: 1_000 }, 1_000_000),
      structureType: "storage",
    },
    {
      cooldown: 4,
      hits: 3_000,
      hitsMax: 3_000,
      id: "terminal-f",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(21, 25, "W1N1"),
      store: makeStore({ energy: 8_000, H: 2_000 }, 300_000),
      structureType: "terminal",
    },
    {
      cooldown: 2,
      hits: 500,
      hitsMax: 500,
      id: "extractor-g",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(7, 40, "W1N1"),
      structureType: "extractor",
    },
    {
      cooldown: 6,
      energyCapacity: 2_000,
      hits: 500,
      hitsMax: 500,
      id: "lab-h",
      isActive: () => true,
      mineralAmount: 500,
      mineralCapacity: 3_000,
      mineralType: "UH",
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(22, 24, "W1N1"),
      store: makeStore({ energy: 1_200, UH: 500 }, 5_000, { energy: 2_000, H: 3_000, UH: 3_000 }),
      structureType: "lab",
    },
    {
      cooldown: 12,
      effects: [{ effect: 19, level: 2, ticksRemaining: 80 }],
      hits: 1_000,
      hitsMax: 1_000,
      id: "factory-i",
      isActive: () => true,
      level: 2,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(18, 25, "W1N1"),
      store: makeStore({ energy: 2_000, wire: 50 }, 50_000),
      structureType: "factory",
    },
    {
      effects: [],
      hits: 5_000,
      hitsMax: 5_000,
      id: "power-spawn-j",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(19, 25, "W1N1"),
      store: makeStore({ energy: 5_000, power: 100 }, 5_100),
      structureType: "powerSpawn",
    },
    {
      effects: [{ effect: 7, level: 1, ticksRemaining: 30 }],
      hits: 500,
      hitsMax: 500,
      id: "observer-k",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(17, 25, "W1N1"),
      structureType: "observer",
    },
    {
      cooldown: 45,
      effects: [],
      hits: 1_000,
      hitsMax: 1_000,
      id: "nuker-l",
      isActive: () => true,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(16, 25, "W1N1"),
      store: makeStore({ energy: 300_000, G: 5_000 }, 305_000),
      structureType: "nuker",
    },
  ];
  const hostileBody = Array.from({ length: hostileBodySize }, (_, index) => ({
    boost: index % 2 === 0 ? "UH" : undefined,
    hits: index === 1 ? 0 : 100,
    type: index % 2 === 0 ? "attack" : "heal",
  }));
  const creeps = [
    {
      body: [
        { hits: 100, type: "work" },
        { hits: 100, type: "carry" },
        { hits: 100, type: "move" },
      ],
      fatigue: 0,
      hits: 300,
      hitsMax: 300,
      id: "creep-b",
      my: true,
      name: "worker-1",
      owner: { username: "Myrmex" },
      pos: new LivePosition(22, 25, "W1N1"),
      spawning: false,
      store: makeStore({ energy: 25 }, 50),
      ticksToLive: 1_200,
    },
    {
      body: hostileBody,
      fatigue: 2,
      hits: 200,
      hitsMax: 300,
      id: "creep-a",
      my: false,
      name: "raider",
      owner: { username: "Enemy" },
      pos: new LivePosition(40, 40, "W1N1"),
      spawning: false,
      store: makeStore({}, 0),
      ticksToLive: 900,
    },
  ];
  const constructionSites = [
    {
      id: "site-a",
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(26, 25, "W1N1"),
      progress: 100,
      progressTotal: 3_000,
      structureType: "extension",
    },
    {
      id: "site-hostile",
      my: false,
      owner: { username: "Enemy" },
      pos: new LivePosition(45, 45, "W1N1"),
      progress: 0,
      progressTotal: 3_000,
      structureType: "tower",
    },
  ];
  const room = {
    controller: {
      id: "controller-a",
      level: 4,
      my: true,
      owner: { username: "Myrmex" },
      pos: new LivePosition(25, 24, "W1N1"),
      progress: 20_000,
      progressTotal: 40_000,
      reservation: undefined,
      safeMode: undefined,
      safeModeAvailable: 2,
      safeModeCooldown: undefined,
      ticksToDowngrade: 40_000,
      upgradeBlocked: undefined,
    },
    energyAvailable: 550,
    energyCapacityAvailable: 800,
    getTerrain: () => ({ get: () => 0 }),
    find: (findType: number): unknown[] => {
      const values: readonly unknown[] =
        findType === FIND_CREEPS_VALUE
          ? creeps
          : findType === FIND_SOURCES_VALUE
            ? sources
            : findType === FIND_STRUCTURES_VALUE
              ? structures
              : findType === FIND_CONSTRUCTION_SITES_VALUE
                ? constructionSites
                : findType === FIND_MINERALS_VALUE
                  ? [
                      {
                        density: 2,
                        id: "mineral-a",
                        mineralAmount: 12_000,
                        mineralType: "H",
                        pos: new LivePosition(7, 40, "W1N1"),
                        ticksToRegeneration: 321,
                      },
                    ]
                  : [];

      return maybeReverse(values, reversed);
    },
    name: "W1N1",
  };

  return {
    room: room as unknown as Room,
    sourcePosition,
    spawnStore: liveSpawnStore as unknown as Record<string, number>,
  };
}

function makeNeutralRoom(reversed: boolean): Room {
  const sources = [
    {
      energy: 3_000,
      energyCapacity: 3_000,
      id: "source-z",
      pos: new LivePosition(10, 10, "W2N2"),
      ticksToRegeneration: null,
    },
  ];
  const room = {
    controller: undefined,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    getTerrain: () => ({ get: () => 0 }),
    find: (findType: number): unknown[] =>
      maybeReverse(findType === FIND_SOURCES_VALUE ? sources : [], reversed),
    name: "W2N2",
  };

  return room as unknown as Room;
}

function makeStore(
  resources: Record<string, number>,
  capacity: number,
  resourceCapacities: Readonly<Record<string, number>> = {},
): StoreLikeFixture {
  const capacityFor = (resource?: string) =>
    resource === undefined ? capacity : (resourceCapacities[resource] ?? capacity);
  const usedFor = (resource?: string) =>
    resource === undefined ? sumValues(resources) : (resources[resource] ?? 0);
  const store: StoreLikeFixture = {
    ...resources,
    getCapacity: (resource) => capacityFor(resource),
    getFreeCapacity: (resource) => capacityFor(resource) - usedFor(resource),
    getUsedCapacity: (resource) => usedFor(resource),
  };

  return store;
}

interface StoreLikeFixture {
  [key: string]: number | ((resource?: string) => number);
  getCapacity: (resource?: string) => number;
  getFreeCapacity: (resource?: string) => number;
  getUsedCapacity: (resource?: string) => number;
}

function sumValues(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

function maybeReverse<T>(values: readonly T[], reversed: boolean): T[] {
  return reversed ? [...values].reverse() : [...values];
}

function withoutFindResults(room: Room, omittedFindType: number): Room {
  const mock = room as unknown as {
    readonly controller: unknown;
    readonly energyAvailable: number;
    readonly energyCapacityAvailable: number;
    readonly find: (findType: number) => unknown[];
    readonly name: string;
  };

  return {
    ...mock,
    find: (findType: number): unknown[] =>
      findType === omittedFindType ? [] : mock.find(findType),
  } as unknown as Room;
}

function creepVariant(
  creep: Creep,
  overrides: { readonly name?: string; readonly pos?: LivePosition },
): Creep {
  return {
    body: creep.body,
    fatigue: creep.fatigue,
    hits: creep.hits,
    hitsMax: creep.hitsMax,
    id: creep.id,
    my: creep.my,
    name: overrides.name ?? creep.name,
    owner: creep.owner,
    pos: overrides.pos ?? creep.pos,
    spawning: creep.spawning,
    store: creep.store,
    ticksToLive: creep.ticksToLive,
  } as unknown as Creep;
}

function assertPlainAndFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    expect(typeof value).not.toBe("function");
    return;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  expect([Object.prototype, Array.prototype, null]).toContain(prototype);
  expect(Object.isFrozen(value)).toBe(true);

  for (const child of Object.values(value)) {
    assertPlainAndFrozen(child);
  }
}
