import { buildRuntimeConfig } from "../../src/config/runtime-config";
import {
  composeMatureInfrastructure,
  type MatureMechanicsInput,
} from "../../src/industry/mature-composition";
import type { MaturePolicyCommitment } from "../../src/industry/mature-policy";
import type { PendingMatureAttempt } from "../../src/industry/mature-runtime";
import type { StoreSnapshot, WorldSnapshot } from "../../src/world/snapshot";

export const MATURE_FIXTURE_POLICY = buildRuntimeConfig().policy.industry;

export const MATURE_FIXTURE_MECHANICS: MatureMechanicsInput = {
  commodities: {
    wire: { amount: 20, components: { energy: 40, silicon: 100 }, cooldown: 8 },
  },
  constants: {
    factoryCapacity: 50_000,
    nukerCooldown: 100_000,
    nukerEnergyCapacity: 300_000,
    nukerGhodiumCapacity: 5_000,
    nukerRange: 10,
    observerRange: 10,
    operateFactoryPower: 19,
    operateObserverPower: 7,
    operatePowerEffects: [1, 2, 3, 4, 5],
    operatePowerPower: 16,
    powerSpawnEnergyCapacity: 5_000,
    powerSpawnEnergyPerPower: 50,
    powerSpawnPowerCapacity: 100,
  },
  resourceTypes: ["G", "energy", "power", "silicon", "wire"],
};

export function composeMatureFixture(
  options: {
    readonly funded?: ReadonlySet<string>;
    readonly mechanics?: MatureMechanicsInput;
    readonly pendingAttempts?: readonly PendingMatureAttempt[];
    readonly previousCommitments?: readonly MaturePolicyCommitment[];
    readonly snapshot?: WorldSnapshot;
  } = {},
) {
  const snapshot = options.snapshot ?? matureCompositionWorld();
  return composeMatureInfrastructure({
    fundedBudgetIds: options.funded ?? new Set(),
    mechanics: options.mechanics ?? MATURE_FIXTURE_MECHANICS,
    pendingAttempts: options.pendingAttempts ?? [],
    policy: MATURE_FIXTURE_POLICY,
    previousCommitments: options.previousCommitments ?? [],
    snapshot,
    snapshotRevision: `snapshot/${String(snapshot.observedAt)}`,
  });
}

export function matureCompositionWorld(
  options: {
    readonly inventory?: Readonly<Record<string, number>>;
    readonly reverse?: boolean;
    readonly tick?: number;
    readonly visibleRoomName?: string;
  } = {},
): WorldSnapshot {
  const roomName = "W1N1";
  const tick = options.tick ?? 100;
  const inventory = options.inventory ?? {
    G: 6_000,
    energy: 320_000,
    power: 1_100,
    silicon: 2_000,
    wire: 0,
  };
  const position = (x: number) => ({ roomName, x, y: 20 });
  const storageStore = store(inventory, 1_000_000);
  const factoryStore = store({ energy: 40, silicon: 100 }, 50_000);
  const powerStore = store({ energy: 5_000, power: 100 }, 5_100);
  const nukerStore = store({}, 305_000);
  const structures = [
    stored("factory", "factory", position(21), factoryStore),
    stored("nuker", "nuker", position(23), nukerStore),
    stored("power-spawn", "powerSpawn", position(22), powerStore),
    stored("storage", "storage", position(20), storageStore),
  ];
  if (options.reverse === true) structures.reverse();
  const room = {
    controller: { level: 8, ownership: "owned" },
    name: roomName,
    observedAt: tick,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedFactories: [
      {
        active: true,
        cooldown: 0,
        effects: [],
        hits: 1_000,
        hitsMax: 1_000,
        id: "factory",
        level: null,
        pos: position(21),
        store: factoryStore,
      },
    ],
    ownedNukers: [
      {
        active: true,
        cooldown: 0,
        effects: [],
        hits: 1_000,
        hitsMax: 1_000,
        id: "nuker",
        pos: position(23),
        store: nukerStore,
      },
    ],
    ownedObservers: [
      {
        active: true,
        effects: [],
        hits: 500,
        hitsMax: 500,
        id: "observer",
        pos: position(24),
      },
    ],
    ownedPowerSpawns: [
      {
        active: true,
        effects: [],
        hits: 5_000,
        hitsMax: 5_000,
        id: "power-spawn",
        pos: position(22),
        store: powerStore,
      },
    ],
    ownedSpawns: [],
    ownedStorages: [
      {
        active: true,
        hits: 10_000,
        hitsMax: 10_000,
        id: "storage",
        pos: position(20),
        store: storageStore,
      },
    ],
    ownedTerminals: [],
    ownedTowers: [],
    sources: [],
    storedStructures: structures,
    constructionSites: [],
    hostileCreeps: [],
    energyAvailable: 0,
    energyCapacityAvailable: 0,
  };
  const visible =
    options.visibleRoomName === undefined
      ? []
      : [
          {
            ...room,
            controller: null,
            name: options.visibleRoomName,
            observedAt: tick,
            ownedFactories: [],
            ownedNukers: [],
            ownedObservers: [],
            ownedPowerSpawns: [],
            ownedStorages: [],
            storedStructures: [],
          },
        ];
  const rooms = [room, ...visible];
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    ownedRooms: [room],
    rooms,
    schemaVersion: 1,
    stats: { entities: {} as never, estimatedPayloadBytes: 0 },
    visibility: {
      absentRoomSemantics: "unknown",
      rooms: visible.map(({ name }) => ({
        age: 0,
        observedAt: tick,
        roomName: name,
        status: "visible",
      })),
      scope: "current-tick",
    },
  } as unknown as WorldSnapshot;
}

function stored(
  id: string,
  structureType: string,
  pos: { readonly roomName: string; readonly x: number; readonly y: number },
  value: StoreSnapshot,
) {
  return {
    active: true,
    effects: [],
    hits: 1_000,
    hitsMax: 1_000,
    id,
    ownership: "owned",
    pos,
    store: value,
    structureType,
  };
}

function store(resources: Readonly<Record<string, number>>, capacity: number): StoreSnapshot {
  const entries = Object.entries(resources)
    .map(([resourceType, amount]) => ({ amount, resourceType }))
    .sort((left, right) => left.resourceType.localeCompare(right.resourceType));
  const usedCapacity = entries.reduce((total, { amount }) => total + amount, 0);
  return { capacity, freeCapacity: capacity - usedCapacity, resources: entries, usedCapacity };
}
