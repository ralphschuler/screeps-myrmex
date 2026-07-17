import { describe, expect, it } from "vitest";
import {
  normalizeMatureMechanics,
  type MatureMechanicsCatalog,
} from "../src/industry/mature-capabilities";
import {
  projectMatureResourceDemands,
  type MatureResourceDemandLimits,
  type MatureResourceObjective,
} from "../src/logistics/mature-resource-demands";
import { observeLogisticsGraph } from "../src/logistics/runtime";
import type { StoreSnapshot, WorldSnapshot } from "../src/world/snapshot";

const LIMITS: MatureResourceDemandLimits = {
  maximumAmountPerTransfer: 500_000,
  maximumBatches: 100,
  maximumEdges: 32,
  maximumNodes: 32,
  maximumObjectives: 16,
  maximumTransfersPerObjective: 8,
};

describe("mature resource-demand projection", () => {
  it("projects factory fills and drains against generic sources without duplicating stock", () => {
    const result = project([factoryObjective()]);

    expect(result.blockers).toEqual([]);
    expect(
      result.edges.map(({ id, maximumAmount, sourceNodeId }) => ({
        id,
        maximumAmount,
        sourceNodeId,
      })),
    ).toEqual([
      {
        id: "mature-demand:factory:r1:drain:mist",
        maximumAmount: 25,
        sourceNodeId: "store:factory:source:mist",
      },
      {
        id: "mature-demand:factory:r1:drain:switch",
        maximumAmount: 5,
        sourceNodeId: "store:factory:source:switch",
      },
      {
        id: "mature-demand:factory:r1:fill:energy",
        maximumAmount: 10,
        sourceNodeId: "store:storage:source:energy",
      },
      {
        id: "mature-demand:factory:r1:fill:wire",
        maximumAmount: 30,
        sourceNodeId: "store:storage:source:wire",
      },
    ]);
    expect(
      result.nodes.every(({ kind, observedAmount }) => kind === "sink" && observedAmount === 0),
    ).toBe(true);
    expect(
      new Set(result.nodes.map(({ capacityReservationKey }) => capacityReservationKey)),
    ).toEqual(
      new Set(["store:W1N1:factory:aggregate-capacity", "store:W1N1:storage:aggregate-capacity"]),
    );
    const observed = observeLogisticsGraph(world(), true);
    expect(observed.nodes.filter(({ id }) => id === "store:storage:source:wire")).toHaveLength(1);
    expect(result.nodes.some(({ id }) => id === "store:storage:source:wire")).toBe(false);
  });

  it("projects bounded power-spawn and one-way nuker fills", () => {
    const result = project([powerObjective(), nukerObjective()]);

    expect(result.blockers).toEqual([]);
    expect(result.edges.map(({ id, maximumAmount }) => [id, maximumAmount])).toEqual([
      ["mature-demand:nuker:r1:fill:G", 4_000],
      ["mature-demand:nuker:r1:fill:energy", 200_000],
      ["mature-demand:power:r1:fill:energy", 2_500],
      ["mature-demand:power:r1:fill:power", 50],
    ]);
    expect(
      result.edges.some(({ sourceNodeId }) => sourceNodeId.startsWith("store:nuker:source:")),
    ).toBe(false);
    expect(
      observeLogisticsGraph(world(), true).nodes.some(({ id }) =>
        id.startsWith("store:nuker:source:"),
      ),
    ).toBe(false);
  });

  it.each([
    ["unfunded", { funded: false }, "unfunded"],
    ["stale", { mechanicsFingerprint: "stale" }, "stale-mechanics"],
    ["expired", { deadline: 9 }, "expired-deadline"],
    ["oversized", { batches: 101 }, "invalid-objective"],
  ] as const)("fails closed for an %s objective", (_name, overrides, reason) => {
    const result = project([factoryObjective(overrides)]);
    expect(result.blockers).toEqual([{ objectiveId: "factory", reason, revision: 1 }]);
    expect(result.edges).toEqual([]);
    expect(result.nodes).toEqual([]);
  });

  it("fails closed when shared factory or endpoint capacity is infeasible", () => {
    const constrained = world({ factoryFree: 5 });
    const result = projectMatureResourceDemands({
      catalog: catalog(),
      limits: LIMITS,
      objectives: [factoryObjective()],
      world: constrained,
    });
    expect(result.blockers[0]?.reason).toBe("capacity-infeasible");
    expect(result.edges).toEqual([]);
  });

  it("is byte-equivalent after reorder and a simulated heap reset", () => {
    const objectives = [factoryObjective(), powerObjective(), nukerObjective()];
    const forward = project(objectives);
    const reversed = project([...objectives].reverse());
    const reset = project(JSON.parse(JSON.stringify(objectives)) as MatureResourceObjective[]);

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(JSON.stringify(reset)).toBe(JSON.stringify(forward));
    expect(JSON.stringify(forward)).not.toContain("produce");
    expect(JSON.stringify(forward)).not.toContain("processPower");
    expect(JSON.stringify(forward)).not.toContain("launchNuke");
  });
});

function project(objectives: readonly MatureResourceObjective[]) {
  return projectMatureResourceDemands({
    catalog: catalog(),
    limits: LIMITS,
    objectives,
    world: world(),
  });
}

function factoryObjective(
  overrides: Partial<MatureResourceObjective> = {},
): MatureResourceObjective {
  return {
    batches: 1,
    colonyId: "W1N1",
    deadline: 20,
    endpointId: "storage",
    funded: true,
    id: "factory",
    industryBudgetId: "industry:factory",
    kind: "factory-batch",
    mechanicsFingerprint: catalog().fingerprint,
    priority: "normal",
    product: "switch",
    revision: 1,
    structureId: "factory",
    ...overrides,
  } as MatureResourceObjective;
}

function powerObjective(): MatureResourceObjective {
  return {
    colonyId: "W1N1",
    deadline: 20,
    endpointId: "storage",
    funded: true,
    id: "power",
    industryBudgetId: "industry:power",
    kind: "power-processing",
    mechanicsFingerprint: catalog().fingerprint,
    priority: "normal",
    revision: 1,
    structureId: "power-spawn",
    units: 100,
  };
}

function nukerObjective(): MatureResourceObjective {
  return {
    colonyId: "W1N1",
    deadline: 20,
    endpointId: "storage",
    energyTarget: 300_000,
    funded: true,
    ghodiumTarget: 5_000,
    id: "nuker",
    industryBudgetId: "industry:nuker",
    kind: "nuker-stock",
    mechanicsFingerprint: catalog().fingerprint,
    priority: "normal",
    revision: 1,
    structureId: "nuker",
  };
}

function catalog(): MatureMechanicsCatalog {
  const result = normalizeMatureMechanics({
    commodities: {
      switch: { amount: 5, components: { energy: 20, wire: 40 }, cooldown: 70, level: 2 },
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
      powerSpawnEnergyCapacity: 5_000,
      powerSpawnEnergyPerPower: 50,
      powerSpawnPowerCapacity: 100,
    },
    limits: {
      maximumCommodities: 8,
      maximumComponentsPerCommodity: 4,
      maximumResourceTypes: 16,
      maximumStringLength: 32,
    },
    resourceTypes: ["G", "energy", "mist", "power", "switch", "wire"],
  });
  if (result.status !== "ready") throw new Error("fixture catalog must normalize");
  return result.catalog;
}

function world(overrides: { readonly factoryFree?: number } = {}): WorldSnapshot {
  const storageStore = store({ G: 5_000, energy: 600_000, power: 100, wire: 1_000 }, 1_000_000);
  const factoryStore = store(
    { energy: 10, mist: 25, switch: 5, wire: 10 },
    50_000,
    overrides.factoryFree,
  );
  const powerStore = store({ energy: 2_500, power: 50 }, 5_100);
  const nukerStore = store({ G: 1_000, energy: 100_000 }, 305_000);
  const position = (x: number) => ({ roomName: "W1N1", x, y: 20 });
  const controller = { level: 8, ownership: "owned" };
  const room = {
    constructionSites: [],
    controller,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    name: "W1N1",
    observedAt: 10,
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
        level: 2,
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
    ownedObservers: [],
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
    storedStructures: [
      stored("factory", "factory", factoryStore, position(21)),
      stored("nuker", "nuker", nukerStore, position(23)),
      stored("power-spawn", "powerSpawn", powerStore, position(22)),
      stored("storage", "storage", storageStore, position(20)),
    ],
  };
  return {
    observation: { age: 0, shard: "shard3", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 0,
    ownedRooms: [room],
    rooms: [room],
    schemaVersion: 1,
    stats: { entities: {} as never, estimatedPayloadBytes: 0 },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  } as unknown as WorldSnapshot;
}

function stored(
  id: string,
  structureType: string,
  value: StoreSnapshot,
  pos: { roomName: string; x: number; y: number },
) {
  return {
    hits: 1_000,
    hitsMax: 1_000,
    id,
    ownerUsername: "Myrmex",
    ownership: "owned",
    pos,
    store: value,
    structureType,
  };
}

function store(
  resources: Readonly<Record<string, number>>,
  capacity: number,
  freeOverride?: number,
): StoreSnapshot {
  const entries = Object.entries(resources)
    .map(([resourceType, amount]) => ({ amount, resourceType }))
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const usedCapacity = entries.reduce((total, { amount }) => total + amount, 0);
  return {
    capacity,
    freeCapacity: freeOverride ?? capacity - usedCapacity,
    resources: entries,
    usedCapacity,
  };
}
