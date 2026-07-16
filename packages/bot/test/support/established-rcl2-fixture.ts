import type { RuntimeGame } from "../../src/runtime/context";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;
const START_TICK = 100;

export interface EstablishedRcl2WorldOptions {
  readonly reverseCollections?: boolean;
}

export interface EstablishedRcl2SpawnCall {
  readonly body: readonly BodyPartConstant[];
  readonly cost: number;
  readonly name: string;
  readonly tick: number;
}

export function establishedRcl2World(options: EstablishedRcl2WorldOptions = {}) {
  let tick = START_TICK - 1;
  let spawnEnergy = 300;
  const extensionEnergy = new Map([
    ["extension-a", 0],
    ["extension-b", 0],
  ]);
  let siteProgress = 5;
  const constructionSiteCalls = 0;
  const sourceEnergy = { value: 3_000 };
  let droppedEnergy = 0;
  let droppedResourceId = "drop-source-a-0";
  let droppedResourceSequence = 0;
  let droppedPosition = { roomName: "W1N1", x: 10, y: 9 };
  const spawnCalls: EstablishedRcl2SpawnCall[] = [];
  let worker: Creep | null = null;
  let workerEnergy = 50;
  let replacementVisibleAt: number | null = null;
  let replacementUsefulWorkAt: number | null = null;
  let replacementWorkerId: string | null = null;
  let pendingSpawn: {
    readonly body: readonly BodyPartConstant[];
    readonly completeAt: number;
    readonly name: string;
  } | null = null;
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
    get spawning() {
      return pendingSpawn === null
        ? null
        : {
            name: pendingSpawn.name,
            needTime: pendingSpawn.body.length * 3,
            remainingTime: Math.max(1, pendingSpawn.completeAt - tick),
          };
    },
    spawnCreep: (body: BodyPartConstant[], name: string) => {
      if (pendingSpawn !== null) return -4;
      if (worker?.name === name) return -3;
      const cost = body.reduce((total, part) => total + bodyPartCost(part), 0);
      if (room.energyAvailable < cost) return -6;
      let remaining = cost;
      for (const [id, energy] of extensionEnergy) {
        const used = Math.min(energy, remaining);
        extensionEnergy.set(id, energy - used);
        remaining -= used;
      }
      spawnEnergy -= remaining;
      spawnCalls.push({ body: [...body], cost, name, tick });
      pendingSpawn = { body: [...body], completeAt: tick + body.length * 3, name };
      return 0;
    },
    store: storeFor(() => spawnEnergy, 300),
    structureType: "spawn",
  } as unknown as StructureSpawn;
  const source = {
    energyCapacity: 3_000,
    get energy() {
      return sourceEnergy.value;
    },
    id: "source-a",
    pos: position(11, 10),
    ticksToRegeneration: 300,
  } as unknown as Source;
  const droppedResource = {
    get amount() {
      return droppedEnergy;
    },
    get id() {
      return droppedResourceId;
    },
    get pos() {
      return droppedPosition;
    },
    resourceType: "energy",
  } as unknown as Resource;
  const produceStaticDrop = () => {
    if (sourceEnergy.value <= 0 || droppedEnergy >= 50) return;
    const amount = Math.min(10, 50 - droppedEnergy, sourceEnergy.value);
    if (droppedEnergy === 0) {
      droppedResourceSequence += 1;
      droppedResourceId = `drop-source-a-${String(droppedResourceSequence)}`;
    }
    sourceEnergy.value -= amount;
    droppedEnergy += amount;
    droppedPosition = position(staticMinerPosition.x, staticMinerPosition.y);
  };

  const markReplacementWork = (result: number) => {
    if (result === 0 && replacementWorkerId !== null && worker?.id === replacementWorkerId) {
      replacementUsefulWorkAt ??= tick;
    }
    return result;
  };
  const createWorker = (
    id: string,
    name: string,
    body: readonly BodyPartConstant[],
    initialEnergy: number,
  ): Creep => {
    workerEnergy = initialEnergy;
    const capacity = body.filter((part) => part === "carry").length * 50;
    return {
      body: body.map((type) => ({ hits: 100, type })),
      get fatigue() {
        return 0;
      },
      hits: body.length * 100,
      hitsMax: body.length * 100,
      id,
      my: true,
      name,
      owner: { username: "Myrmex" },
      pos: position(11, 10),
      spawning: false,
      store: storeFor(() => workerEnergy, capacity),
      ticksToLive: 1_000,
      build: (target: ConstructionSite) => {
        if (target.id !== site.id) return -7;
        if (workerEnergy < 5) return -6;
        workerEnergy -= 5;
        siteProgress += 5;
        return markReplacementWork(0);
      },
      repair: () => -7,
      harvest: (target: Source) => {
        if (target.id !== source.id || workerEnergy >= capacity || sourceEnergy.value <= 0)
          return -6;
        const amount = Math.min(2, capacity - workerEnergy, sourceEnergy.value);
        workerEnergy += amount;
        sourceEnergy.value -= amount;
        return markReplacementWork(0);
      },
      transfer: (target: AnyStoreStructure, resource: ResourceConstant, amount?: number) => {
        if (resource !== "energy") return -6;
        const targetId = String(target.id);
        const targetEnergy = targetId === spawn.id ? spawnEnergy : extensionEnergy.get(targetId);
        const targetCapacity =
          targetId === spawn.id ? 300 : extensionEnergy.has(targetId) ? 50 : null;
        if (targetEnergy === undefined || targetCapacity === null) return -6;
        const amountToTransfer = Math.min(
          amount ?? workerEnergy,
          workerEnergy,
          targetCapacity - targetEnergy,
        );
        if (amountToTransfer <= 0) return -8;
        workerEnergy -= amountToTransfer;
        if (targetId === spawn.id) spawnEnergy += amountToTransfer;
        else extensionEnergy.set(targetId, targetEnergy + amountToTransfer);
        return markReplacementWork(0);
      },
      pickup: (target: Resource) => {
        if (target.id !== droppedResource.id || droppedEnergy <= 0 || workerEnergy >= capacity)
          return -7;
        const amount = Math.min(droppedEnergy, capacity - workerEnergy);
        droppedEnergy -= amount;
        workerEnergy += amount;
        return markReplacementWork(0);
      },
      withdraw: () => -7,
      upgradeController: () => -7,
      move: () => -7,
    } as unknown as Creep;
  };
  worker = createWorker("worker-a", "worker-a", ["work", "carry", "carry", "move"], 50);

  const staticMinerPosition = { x: 10, y: 9 };
  const staticMiner = {
    body: ["work", "work", "work", "work", "work", "move"].map((type) => ({ hits: 100, type })),
    fatigue: 0,
    hits: 600,
    hitsMax: 600,
    id: "static-miner-a",
    my: true,
    name: "static-miner-a",
    owner: { username: "Myrmex" },
    get pos() {
      return position(staticMinerPosition.x, staticMinerPosition.y);
    },
    spawning: false,
    store: storeFor(() => 0, 0),
    ticksToLive: 1_000,
    build: () => -7,
    repair: () => -7,
    harvest: (target: Source) => {
      if (target.id !== source.id || sourceEnergy.value <= 0) return -6;
      produceStaticDrop();
      return 0;
    },
    transfer: () => -7,
    pickup: () => -7,
    withdraw: () => -7,
    upgradeController: () => -7,
    move: (direction: DirectionConstant) => {
      const deltas: Record<number, readonly [number, number]> = {
        1: [0, -1],
        2: [1, -1],
        3: [1, 0],
        4: [1, 1],
        5: [0, 1],
        6: [-1, 1],
        7: [-1, 0],
        8: [-1, -1],
      };
      const delta = deltas[direction];
      if (delta === undefined) return -10;
      staticMinerPosition.x += delta[0];
      staticMinerPosition.y += delta[1];
      return 0;
    },
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
        ? options.reverseCollections
          ? [staticMiner, ...(worker === null ? [] : [worker])]
          : [...(worker === null ? [] : [worker]), staticMiner]
        : findType === FIND_DROPPED_RESOURCES_VALUE
          ? droppedEnergy > 0
            ? [droppedResource]
            : []
          : findType === FIND_STRUCTURES_VALUE
            ? options.reverseCollections
              ? [spawn, ...extensions].reverse()
              : [spawn, ...extensions]
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
    controllerTicksToDowngrade: () => controller.ticksToDowngrade,
    extensionEnergy: () => [...extensionEnergy.values()].reduce((sum, value) => sum + value, 0),
    game: (nextTick: number): RuntimeGame => {
      if (nextTick <= tick) throw new Error("ticks must advance monotonically");
      tick = nextTick;
      produceStaticDrop();
      if (pendingSpawn !== null && nextTick >= pendingSpawn.completeAt) {
        replacementWorkerId = `replacement-${pendingSpawn.name}`;
        worker = createWorker(replacementWorkerId, pendingSpawn.name, pendingSpawn.body, 0);
        replacementVisibleAt = nextTick;
        pendingSpawn = null;
      }
      const creeps = {
        ...(worker === null ? {} : { [worker.name]: worker }),
        [staticMiner.name]: staticMiner,
      };
      return {
        cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        creeps,
        getObjectById: (id: string) =>
          id === worker?.id
            ? worker
            : id === staticMiner.id
              ? staticMiner
              : id === droppedResource.id && droppedEnergy > 0
                ? droppedResource
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
    killWorker: () => {
      worker = null;
      workerEnergy = 0;
    },
    replacementUsefulWorkAt: () => replacementUsefulWorkAt,
    replacementVisibleAt: () => replacementVisibleAt,
    replacementWorkerId: () => replacementWorkerId,
    roomEnergy: () => room.energyAvailable,
    siteCount: () => 1,
    siteProgress: () => siteProgress,
    spawnCalls: () => [...spawnCalls],
    spawnEnergy: () => spawnEnergy,
  };
}

function bodyPartCost(part: BodyPartConstant): number {
  return {
    attack: 80,
    carry: 50,
    claim: 600,
    heal: 250,
    move: 50,
    ranged_attack: 150,
    tough: 10,
    work: 100,
  }[part];
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
