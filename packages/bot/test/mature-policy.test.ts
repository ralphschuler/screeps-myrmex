import { describe, expect, it } from "vitest";
import {
  normalizeMatureMechanics,
  type MatureMechanicsCatalog,
  type MatureStructureCapability,
} from "../src/industry/mature-capabilities";
import {
  reconcileMaturePolicy,
  type MatureFactoryCandidate,
  type MaturePolicyLimits,
} from "../src/industry/mature-policy";
import type { MatureResourceDemandDisposition } from "../src/logistics/mature-resource-demands";
import type { StoreSnapshot, WorldSnapshot } from "../src/world/snapshot";

const LIMITS: MaturePolicyLimits = {
  maximumBatchesPerObjective: 10,
  maximumCandidates: 8,
  maximumDeadlineHorizon: 50,
  maximumNukerEnergyTarget: 300_000,
  maximumNukerGhodiumTarget: 5_000,
  maximumObjectives: 8,
  maximumPowerProcessingUnits: 100,
  maximumRooms: 4,
};

describe("mature infrastructure policy", () => {
  it("emits matching budgets before objectives become funded or ready", () => {
    const first = project();
    expect(first.budgets.map(({ issuer }) => issuer)).toEqual(
      first.objectives.map(({ industryBudgetId }) => industryBudgetId),
    );
    expect(first.objectives.every(({ funded }) => !funded)).toBe(true);
    expect(first.commitments.every(({ status }) => status === "pending-funding")).toBe(true);

    const fundedIds = new Set(first.budgets.map(({ issuer }) => issuer));
    const funded = project({ fundedBudgetIds: fundedIds, dispositions: dispositions(first) });
    expect(funded.objectives.every(({ funded: value }) => value)).toBe(true);
    expect(funded.commitments.every(({ status }) => status === "ready")).toBe(true);
  });

  it("selects positive-value factory work and bounds it by protected component stock", () => {
    const result = project({
      candidates: [
        {
          maximumBatches: 10,
          product: "switch",
          roomName: "W1N1",
          targetStock: 100,
          valuePerBatch: 5,
        },
        {
          maximumBatches: 10,
          product: "wire",
          roomName: "W1N1",
          targetStock: 100,
          valuePerBatch: -1,
        },
      ],
      protectedStocks: [
        { amount: 499_950, resourceType: "energy", roomName: "W1N1" },
        { amount: 800, resourceType: "wire", roomName: "W1N1" },
      ],
    });
    const factory = result.objectives.find(({ kind }) => kind === "factory-batch");
    expect(factory).toMatchObject({ batches: 2, product: "switch" });
    expect(result.blockers.some(({ identity }) => identity.includes("wire"))).toBe(false);
  });

  it("funds power and capped nuker stock only from surplus above reserves", () => {
    const result = project();
    expect(result.objectives.find(({ kind }) => kind === "power-processing")).toMatchObject({
      units: 100,
    });
    expect(result.objectives.find(({ kind }) => kind === "nuker-stock")).toMatchObject({
      energyTarget: 300_000,
      ghodiumTarget: 5_000,
    });

    const protectedResult = project({
      protectedStocks: [
        { amount: 499_999, resourceType: "energy", roomName: "W1N1" },
        { amount: 9_999, resourceType: "G", roomName: "W1N1" },
        { amount: 199, resourceType: "power", roomName: "W1N1" },
        { amount: 999, resourceType: "wire", roomName: "W1N1" },
      ],
    });
    expect(protectedResult.objectives).toEqual([]);
    expect(protectedResult.blockers).toContainEqual({
      identity: "nuker:W1N1",
      reason: "protected-stock",
    });
  });

  it("downgrades lost funding and preserves blocked logistics explicitly", () => {
    const first = project();
    const fundedIds = new Set(first.budgets.map(({ issuer }) => issuer));
    const blocked = project({
      fundedBudgetIds: fundedIds,
      dispositions: first.objectives.map(({ id, revision }) => ({
        objectiveId: id,
        projectedAmount: 0,
        projectedTransfers: 0,
        revision,
        status: "blocked" as const,
      })),
    });
    expect(blocked.commitments.every(({ status }) => status === "blocked")).toBe(true);
    const lost = project({ previousCommitments: blocked.commitments });
    expect(
      lost.commitments
        .filter(({ status }) => status !== "retired")
        .every(({ status }) => status === "pending-funding"),
    ).toBe(true);
  });

  it("is byte-equivalent after reordered inputs and JSON heap reset", () => {
    const baseline = project();
    const reordered = project({ capabilities: [...capabilities()].reverse() });
    const reset = project({
      candidates: JSON.parse(JSON.stringify(candidates())) as MatureFactoryCandidate[],
      capabilities: JSON.parse(JSON.stringify(capabilities())) as MatureStructureCapability[],
    });
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(baseline));
    expect(JSON.stringify(reset)).toBe(JSON.stringify(baseline));
    expect(JSON.stringify(baseline)).not.toContain("produce");
    expect(JSON.stringify(baseline)).not.toContain("processPower");
    expect(JSON.stringify(baseline)).not.toContain("launchNuke");
  });
});

function project(
  options: {
    capabilities?: readonly MatureStructureCapability[];
    candidates?: readonly MatureFactoryCandidate[];
    dispositions?: readonly MatureResourceDemandDisposition[];
    fundedBudgetIds?: ReadonlySet<string>;
    previousCommitments?: ReturnType<typeof reconcileMaturePolicy>["commitments"];
    protectedStocks?: readonly { amount: number; resourceType: string; roomName: string }[];
  } = {},
) {
  return reconcileMaturePolicy({
    capabilities: options.capabilities ?? capabilities(),
    catalog: catalog(),
    factoryCandidates: options.candidates ?? candidates(),
    fundedBudgetIds: options.fundedBudgetIds ?? new Set(),
    limits: LIMITS,
    logisticsDispositions: options.dispositions ?? [],
    nukerEnergyTarget: 300_000,
    nukerGhodiumTarget: 5_000,
    previousCommitments: options.previousCommitments ?? [],
    protectedStocks: options.protectedStocks ?? [
      { amount: 10_000, resourceType: "energy", roomName: "W1N1" },
    ],
    tick: 10,
    world: world(),
  });
}

function dispositions(
  projection: ReturnType<typeof reconcileMaturePolicy>,
): MatureResourceDemandDisposition[] {
  return projection.objectives.map(({ id, revision }) => ({
    objectiveId: id,
    projectedAmount: 0,
    projectedTransfers: 0,
    revision,
    status: "satisfied",
  }));
}

function candidates() {
  return [
    { maximumBatches: 10, product: "switch", roomName: "W1N1", targetStock: 50, valuePerBatch: 5 },
  ] as const;
}

function capabilities(): MatureStructureCapability[] {
  return [
    capability("factory", "factory", ["switch"]),
    capability("nuker", "nuker"),
    capability("power-spawn", "power-spawn"),
  ];
}

function capability(
  kind: MatureStructureCapability["kind"],
  id: string,
  availableProducts: readonly string[] = [],
): MatureStructureCapability {
  return {
    active: true,
    availableProducts,
    cooldown: 0,
    effectLevels: [],
    fingerprint: `cap:${id}`,
    id,
    kind,
    level: kind === "factory" ? 2 : null,
    processablePower: 0,
    range: 0,
    roomName: "W1N1",
    stocked: false,
    storeFingerprint: `store:${id}`,
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
      operatePowerEffects: [1, 2, 3, 4, 5],
      operatePowerPower: 16,
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
    resourceTypes: ["G", "energy", "power", "switch", "wire"],
  });
  if (result.status !== "ready") throw new Error("catalog fixture must normalize");
  return result.catalog;
}

function world(): WorldSnapshot {
  const position = (x: number) => ({ roomName: "W1N1", x, y: 20 });
  const storage = store(
    { G: 10_000, energy: 500_000, power: 200, switch: 0, wire: 1_000 },
    1_000_000,
  );
  const nuker = store({ G: 1_000, energy: 100_000 }, 305_000);
  const room = {
    controller: { level: 8, ownership: "owned" },
    name: "W1N1",
    observedAt: 10,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedFactories: [],
    ownedNukers: [
      {
        active: true,
        cooldown: 0,
        effects: [],
        hits: 1_000,
        hitsMax: 1_000,
        id: "nuker",
        pos: position(23),
        store: nuker,
      },
    ],
    ownedPowerSpawns: [],
    ownedSpawns: [],
    ownedStorages: [
      {
        active: true,
        hits: 10_000,
        hitsMax: 10_000,
        id: "storage",
        pos: position(20),
        store: storage,
      },
    ],
    ownedTerminals: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    constructionSites: [],
    hostileCreeps: [],
    energyAvailable: 0,
    energyCapacityAvailable: 0,
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

function store(resources: Readonly<Record<string, number>>, capacity: number): StoreSnapshot {
  const entries = Object.entries(resources)
    .map(([resourceType, amount]) => ({ amount, resourceType }))
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const usedCapacity = entries.reduce((sum, { amount }) => sum + amount, 0);
  return { capacity, freeCapacity: capacity - usedCapacity, resources: entries, usedCapacity };
}
