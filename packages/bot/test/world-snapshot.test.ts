import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeGame } from "../src/runtime/context";
import { observeWorld } from "../src/world/observe";
import { emptyWorldSnapshot, freezeWorldSnapshot, utf8ByteLength } from "../src/world/snapshot";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

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
      "spawn-b",
      "tower-c",
    ]);
    expect(forward.rooms[0]?.ownedSpawns[0]?.store.resources).toEqual([
      { amount: 200, resourceType: "energy" },
      { amount: 3, resourceType: "power" },
    ]);
    expect(forward.stats.entities.total).toBe(14);

    const payload = {
      observation: forward.observation,
      observedAt: forward.observedAt,
      ownedRooms: forward.ownedRooms,
      rooms: forward.rooms,
      schemaVersion: forward.schemaVersion,
      visibility: forward.visibility,
    };
    expect(forward.stats.estimatedPayloadBytes).toBe(utf8ByteLength(JSON.stringify(payload)));
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
    find: (findType: number): unknown[] =>
      maybeReverse(findType === FIND_SOURCES_VALUE ? sources : [], reversed),
    name: "W2N2",
  };

  return room as unknown as Room;
}

function makeStore(resources: Record<string, number>, capacity: number): StoreLikeFixture {
  const store: StoreLikeFixture = {
    ...resources,
    getCapacity: () => capacity,
    getFreeCapacity: () => capacity - sumValues(resources),
    getUsedCapacity: () => sumValues(resources),
  };

  return store;
}

interface StoreLikeFixture {
  [key: string]: number | (() => number);
  getCapacity: () => number;
  getFreeCapacity: () => number;
  getUsedCapacity: () => number;
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
