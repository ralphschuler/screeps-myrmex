import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeGame } from "../src/runtime/context";
import { runTick } from "../src/runtime/tick";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const START_TICK = 100;
const MAX_TICKS = 150;

describe("Phase 1 gate established RCL2 row", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("refills RCL2 capacity, advances the observed road site, and preserves reserve", () => {
    const world = establishedRcl2World();
    const memory = {} as Memory;
    const outcomes = [] as ReturnType<typeof runTick>[];

    for (let tick = START_TICK; tick < START_TICK + MAX_TICKS; tick += 1) {
      const outcome = runTick({ game: world.game(tick), memory });
      outcomes.push(outcome);
      expect(world.spawnEnergy()).toBe(300);
      if (world.roomEnergy() === 400 && world.siteProgress() > 0) break;
    }

    expect(world.extensionEnergy()).toBe(100);
    expect(world.roomEnergy()).toBe(400);
    expect(world.spawnEnergy()).toBe(300);
    expect(world.siteProgress()).toBeGreaterThan(0);
    expect(world.constructionSiteCalls()).toBe(0);
    expect(world.siteCount()).toBe(1);
    expect(
      outcomes.some((outcome) =>
        outcome.movement.actionExecution.some(
          ({ intent, status }) => status === "executed" && intent.kind === "transfer",
        ),
      ),
    ).toBe(true);
    expect(
      outcomes.some((outcome) =>
        outcome.movement.actionExecution.some(
          ({ intent, status }) =>
            status === "executed" && intent.kind === "build" && intent.targetId === "road-site",
        ),
      ),
    ).toBe(true);
    expect(
      outcomes.some((outcome) =>
        outcome.colony.reservations.some(
          ({ category, status }) =>
            status === "active" && ["optional-growth", "critical-maintenance"].includes(category),
        ),
      ),
    ).toBe(true);
  });
});

function establishedRcl2World() {
  let tick = START_TICK - 1;
  const spawnEnergy = 300;
  const extensionEnergy = new Map([
    ["extension-a", 0],
    ["extension-b", 0],
  ]);
  let siteProgress = 0;
  const constructionSiteCalls = 0;
  const sourceEnergy = { value: 3_000 };
  const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });
  const site = {
    id: "road-site",
    my: true,
    owner: { username: "Myrmex" },
    pos: position(10, 11),
    progressTotal: 100,
    get progress() {
      return siteProgress;
    },
    structureType: "road",
  } as unknown as ConstructionSite;
  const extensions = [...extensionEnergy].map(([id, energy]) => ({
    hits: 1_000,
    hitsMax: 1_000,
    id,
    isActive: () => true,
    my: true,
    pos: position(id === "extension-a" ? 11 : 12, 10),
    room: { name: "W1N1" },
    store: storeFor(() => extensionEnergy.get(id) ?? energy, 50),
    structureType: "extension",
  })) as unknown as StructureExtension[];
  const spawn = {
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-a",
    isActive: () => true,
    my: true,
    name: "Spawn1",
    owner: { username: "Myrmex" },
    pos: position(10, 10),
    room: { name: "W1N1" },
    spawning: null,
    store: storeFor(() => spawnEnergy, 300),
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const workerEnergy = { value: 50 };
  const source = {
    energyCapacity: 3_000,
    get energy() {
      return sourceEnergy.value;
    },
    id: "source-a",
    pos: position(11, 10),
    ticksToRegeneration: 300,
  } as unknown as Source;
  const worker = {
    body: [
      { hits: 100, type: "work" },
      { hits: 100, type: "carry" },
      { hits: 100, type: "carry" },
      { hits: 100, type: "move" },
    ],
    get fatigue() {
      return 0;
    },
    hits: 300,
    hitsMax: 300,
    id: "worker-a",
    my: true,
    name: "worker-a",
    owner: { username: "Myrmex" },
    pos: position(11, 10),
    spawning: false,
    store: storeFor(() => workerEnergy.value, 100),
    ticksToLive: 1_000,
    build: (target: ConstructionSite) => {
      if (target.id !== site.id) return -7;
      if (workerEnergy.value < 5) return -6;
      workerEnergy.value -= 5;
      siteProgress += 5;
      return 0;
    },
    repair: () => -7,
    harvest: (target: Source) => {
      if (target.id !== source.id || workerEnergy.value >= 100 || sourceEnergy.value <= 0)
        return -6;
      const amount = Math.min(2, 100 - workerEnergy.value, sourceEnergy.value);
      workerEnergy.value += amount;
      sourceEnergy.value -= amount;
      return 0;
    },
    transfer: (target: StructureExtension, resource: ResourceConstant, amount?: number) => {
      if (resource !== "energy" || !extensionEnergy.has(String(target.id))) return -6;
      const id = String(target.id);
      const amountToTransfer = Math.min(
        amount ?? workerEnergy.value,
        workerEnergy.value,
        50 - (extensionEnergy.get(id) ?? 0),
      );
      if (amountToTransfer <= 0) return -8;
      workerEnergy.value -= amountToTransfer;
      extensionEnergy.set(id, (extensionEnergy.get(id) ?? 0) + amountToTransfer);
      return 0;
    },
    pickup: () => -7,
    withdraw: () => -7,
    upgradeController: () => -7,
    move: () => -7,
  } as unknown as Creep;
  const controller = {
    id: "controller-a",
    level: 2,
    my: true,
    owner: { username: "Myrmex" },
    pos: position(8, 10),
    progress: 0,
    progressTotal: 1_000,
    safeMode: undefined,
    safeModeAvailable: 1,
    ticksToDowngrade: 20_000,
    upgradeBlocked: undefined,
  } as unknown as StructureController;
  const room = {
    controller,
    get energyAvailable() {
      return spawnEnergy + [...extensionEnergy.values()].reduce((sum, value) => sum + value, 0);
    },
    energyCapacityAvailable: 400,
    find: (findType: number): unknown[] =>
      findType === FIND_CREEPS_VALUE
        ? [worker]
        : findType === FIND_STRUCTURES_VALUE
          ? [spawn, ...extensions]
          : findType === FIND_CONSTRUCTION_SITES_VALUE
            ? [site]
            : findType === FIND_SOURCES_VALUE
              ? [source]
              : [],
    getTerrain: () => ({ get: () => 0 }),
    name: "W1N1",
  } as unknown as Room;

  return {
    constructionSiteCalls: () => constructionSiteCalls,
    extensionEnergy: () => [...extensionEnergy.values()].reduce((sum, value) => sum + value, 0),
    game: (nextTick: number): RuntimeGame => {
      if (nextTick <= tick) throw new Error("ticks must advance monotonically");
      tick = nextTick;
      return {
        cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        creeps: { "worker-a": worker },
        getObjectById: (id: string) =>
          id === "worker-a"
            ? worker
            : id === "spawn-a"
              ? spawn
              : id === "road-site"
                ? site
                : id === source.id
                  ? source
                  : (extensions.find((extension) => extension.id === id) ?? null),
        rooms: { W1N1: room },
        shard: { name: "shard3" },
        time: nextTick,
      };
    },
    roomEnergy: () => room.energyAvailable,
    siteCount: () => 1,
    siteProgress: () => siteProgress,
    spawnEnergy: () => spawnEnergy,
  };
}

function storeFor(energy: () => number, capacity: number): StoreDefinition {
  return {
    get energy() {
      return energy();
    },
    getCapacity: () => capacity,
    getFreeCapacity: () => capacity - energy(),
    getUsedCapacity: () => energy(),
  } as unknown as StoreDefinition;
}
