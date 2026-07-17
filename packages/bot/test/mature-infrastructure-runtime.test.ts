import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeGame } from "../src/runtime/context";
import { runTick } from "../src/runtime/tick";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const FIND_MINERALS_VALUE = 116;

class Position {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(): number {
    return 1;
  }
}

describe("mature infrastructure static tick composition", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
    vi.stubGlobal("FIND_MINERALS", FIND_MINERALS_VALUE);
    vi.stubGlobal("COMMODITIES", {
      wire: { amount: 20, components: { energy: 40, silicon: 100 }, cooldown: 8 },
    });
    vi.stubGlobal("RESOURCES_ALL", ["G", "energy", "power", "silicon", "wire"]);
    vi.stubGlobal("FACTORY_CAPACITY", 50_000);
    vi.stubGlobal("NUKER_COOLDOWN", 100_000);
    vi.stubGlobal("NUKER_ENERGY_CAPACITY", 300_000);
    vi.stubGlobal("NUKER_GHODIUM_CAPACITY", 5_000);
    vi.stubGlobal("NUKE_RANGE", 10);
    vi.stubGlobal("OBSERVER_RANGE", 10);
    vi.stubGlobal("PWR_OPERATE_FACTORY", 19);
    vi.stubGlobal("PWR_OPERATE_OBSERVER", 7);
    vi.stubGlobal("PWR_OPERATE_POWER", 16);
    vi.stubGlobal("POWER_INFO", { 16: { effect: [1, 2, 3, 4, 5] } });
    vi.stubGlobal("POWER_SPAWN_ENERGY_CAPACITY", 5_000);
    vi.stubGlobal("POWER_SPAWN_ENERGY_RATIO", 50);
    vi.stubGlobal("POWER_SPAWN_POWER_CAPACITY", 100);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("funds, executes once, and settles exact factory and power deltas after a memory reset", () => {
    const world = matureWorld();
    const memory = {} as Memory;

    const first = runTick({ game: world.game(100), memory });
    expect(first.config.features.gates["phase2.mature"]).toMatchObject({ enabled: true });
    expect(world.produce).not.toHaveBeenCalled();
    expect(world.processPower).not.toHaveBeenCalled();

    const scheduled = runTick({ game: world.game(101), memory });
    expect(scheduled.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledOnce();
    expect(world.produce).toHaveBeenCalledWith("wire");
    expect(world.processPower).toHaveBeenCalledOnce();
    expect(memory.myrmex?.industry).toMatchObject({
      schemaVersion: 5,
      matureAttempts: [
        { kind: "factory", observeAt: 102 },
        { kind: "power-processing", observeAt: 102 },
      ],
    });

    world.applyScheduledEffects();
    const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const settled = runTick({ game: world.game(102), memory: resetMemory });
    expect(settled.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledTimes(1);
    expect(world.processPower).toHaveBeenCalledTimes(1);
    expect(resetMemory.myrmex?.industry).toMatchObject({
      schemaVersion: 5,
      matureAttempts: [],
    });
    expect(settled.telemetry?.industry.mature).toMatchObject({
      settlements: { settledFactoryAmount: 20, settledPower: 1 },
    });
  });

  it("marks a no-effect receipt retry-ready and retries without changing its objective", () => {
    const world = matureWorld();
    const memory = {} as Memory;
    runTick({ game: world.game(300), memory });
    runTick({ game: world.game(301), memory });

    const noEffect = runTick({ game: world.game(302), memory });
    expect(noEffect.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledTimes(1);
    expect(world.processPower).toHaveBeenCalledTimes(1);
    expect(memory.myrmex?.industry).toMatchObject({
      matureAttempts: [
        { kind: "factory", retry: 1, retryReady: true },
        { kind: "power-processing", retry: 1, retryReady: true },
      ],
    });

    const retried = runTick({ game: world.game(303), memory });
    expect(retried.kernel.faults).toEqual([]);
    expect(world.produce).toHaveBeenCalledTimes(2);
    expect(world.processPower).toHaveBeenCalledTimes(2);
    expect(memory.myrmex?.industry).toMatchObject({
      matureAttempts: [
        { kind: "factory", retry: 1, observeAt: 304 },
        { kind: "power-processing", retry: 1, observeAt: 304 },
      ],
    });
  });

  it("sheds optional mature planning under constrained CPU without losing durable state", () => {
    const world = matureWorld();
    const memory = {} as Memory;
    runTick({ game: world.game(200), memory });
    const before = JSON.stringify(memory.myrmex?.industry);

    const constrained = runTick({ game: world.game(201, 4_000), memory });

    expect(constrained.kernel.mode).toBe("constrained");
    expect(world.produce).not.toHaveBeenCalled();
    expect(world.processPower).not.toHaveBeenCalled();
    expect(JSON.stringify(memory.myrmex?.industry)).toBe(before);
  });
});

function matureWorld() {
  const roomName = "W1N1";
  const pos = (x: number, y = 20) => new Position(x, y, roomName);
  let factoryResources = { energy: 40, silicon: 100 } as Record<string, number>;
  let factoryCooldown = 0;
  let powerResources = { energy: 5_000, power: 100 } as Record<string, number>;
  const produce = vi.fn((): ScreepsReturnCode => 0);
  const processPower = vi.fn((): ScreepsReturnCode => 0);
  const controller = {
    id: "controller",
    level: 8,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(25),
    progress: 0,
    progressTotal: 0,
    reservation: undefined,
    safeMode: undefined,
    safeModeAvailable: 1,
    safeModeCooldown: undefined,
    ticksToDowngrade: 100_000,
    upgradeBlocked: undefined,
  };
  const liveRoom = {
    controller,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    getTerrain: () => ({ get: () => 0 }),
    name: roomName,
  } as unknown as Room;
  const factory = {
    get cooldown() {
      return factoryCooldown;
    },
    effects: [],
    hits: 1_000,
    hitsMax: 1_000,
    id: "factory",
    isActive: () => true,
    level: null,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(21),
    produce,
    room: liveRoom,
    get store() {
      return store(factoryResources, 50_000);
    },
    structureType: "factory",
  } as unknown as StructureFactory;
  const powerSpawn = {
    effects: [],
    hits: 5_000,
    hitsMax: 5_000,
    id: "power-spawn",
    isActive: () => true,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(22),
    processPower,
    room: liveRoom,
    get store() {
      return store(powerResources, 5_100);
    },
    structureType: "powerSpawn",
  } as unknown as StructurePowerSpawn;
  const storage = {
    hits: 10_000,
    hitsMax: 10_000,
    id: "storage",
    isActive: () => true,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(20),
    store: store({ G: 5_000, energy: 20_000, power: 1_100, silicon: 2_000, wire: 0 }, 1_000_000),
    structureType: "storage",
  } as unknown as StructureStorage;
  const nuker = {
    cooldown: 0,
    effects: [],
    hits: 1_000,
    hitsMax: 1_000,
    id: "nuker",
    isActive: () => true,
    my: true,
    owner: { username: "Myrmex" },
    pos: pos(23),
    store: store({ G: 5_000, energy: 300_000 }, 305_000),
    structureType: "nuker",
  } as unknown as StructureNuker;
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn",
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: pos(24),
    room: liveRoom,
    spawning: null,
    spawnCreep: vi.fn(() => 0),
    store: store({ energy: 300 }, 300),
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const worker = {
    body: [
      { hits: 100, type: "work" },
      { hits: 100, type: "carry" },
      { hits: 100, type: "move" },
    ],
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: "worker",
    my: true,
    name: "worker",
    owner: { username: "Myrmex" },
    pos: pos(24, 21),
    spawning: false,
    store: store({}, 50),
    ticksToLive: 1_000,
  } as unknown as Creep;
  const structures = [factory, powerSpawn, storage, nuker, spawn];
  const find = (findType: number): unknown[] =>
    findType === FIND_CREEPS_VALUE
      ? [worker]
      : findType === FIND_STRUCTURES_VALUE
        ? structures
        : [];
  Object.assign(liveRoom, { find });
  const room = liveRoom;
  const byId = new Map<string, unknown>(structures.map((structure) => [structure.id, structure]));

  return {
    applyScheduledEffects: () => {
      factoryResources = { energy: 0, silicon: 0, wire: 20 };
      factoryCooldown = 7;
      powerResources = { energy: 4_950, power: 99 };
    },
    game: (time: number, bucket = 10_000): RuntimeGame => ({
      cpu: { bucket, limit: 20, tickLimit: 500, getUsed: () => 0 },
      creeps: { worker },
      constructionSites: {},
      getObjectById: (id) => byId.get(id) ?? null,
      market: { calcTransactionCost: () => 0 },
      rooms: { [roomName]: room },
      shard: { name: "shard0" },
      time,
    }),
    processPower,
    produce,
  };
}

function store(resources: Record<string, number>, capacity: number) {
  const usedFor = (resource?: string) =>
    resource === undefined
      ? Object.values(resources).reduce((total, amount) => total + amount, 0)
      : (resources[resource] ?? 0);
  return {
    ...resources,
    getCapacity: () => capacity,
    getFreeCapacity: (resource?: string) => capacity - usedFor(resource),
    getUsedCapacity: (resource?: string) => usedFor(resource),
  };
}
