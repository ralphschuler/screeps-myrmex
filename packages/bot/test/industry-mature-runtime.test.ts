import { describe, expect, it } from "vitest";
import type { MaturePolicyCommitment } from "../src/industry/mature-policy";
import {
  normalizeMatureMechanics,
  type MatureMechanicsCatalog,
  type MatureStructureCapability,
} from "../src/industry/mature-capabilities";
import {
  createPendingMatureAttempt,
  isPendingMatureAttempt,
  markMatureAttemptRetryReady,
  projectMatureCommandIntents,
  reconcilePendingMatureAttempts,
} from "../src/industry/mature-runtime";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("pure mature command arbitration", () => {
  it("projects one funded ready command per factory and power spawn deterministically", () => {
    const input = {
      capabilities: capabilities(),
      catalog: catalog(),
      commitments: [factoryCommitment(), powerCommitment()],
      snapshot: snapshot(),
      snapshotRevision: "shard0:100:fixture",
    };

    const projected = projectMatureCommandIntents(input);
    expect(
      projectMatureCommandIntents({ ...input, commitments: [...input.commitments].reverse() }),
    ).toEqual(projected);
    expect(
      projected.map(({ exclusiveResourceKey, kind, payload }) => ({
        exclusiveResourceKey,
        kind,
        values:
          kind === "factory.produce"
            ? [payload.product, payload.productBefore]
            : [payload.energyBefore, payload.powerBefore, payload.units],
      })),
    ).toEqual([
      {
        exclusiveResourceKey: "mature-structure/factory",
        kind: "factory.produce",
        values: ["wire", 0],
      },
      {
        exclusiveResourceKey: "mature-structure/power-spawn",
        kind: "power-spawn.process-power",
        values: [500, 10, 3],
      },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/observeRoom|launchNuke/);
  });

  it("fails closed for duplicate commitments, duplicate capabilities, and stale mechanics", () => {
    const factory = factoryCommitment();
    const base = {
      catalog: catalog(),
      snapshot: snapshot(),
      snapshotRevision: "revision/100",
    };
    expect(
      projectMatureCommandIntents({
        ...base,
        capabilities: capabilities(),
        commitments: [factory, roundTrip(factory)],
      }),
    ).toEqual([]);
    const factoryCapability = required(capabilities().find(({ kind }) => kind === "factory"));
    expect(
      projectMatureCommandIntents({
        ...base,
        capabilities: [factoryCapability, roundTrip(factoryCapability)],
        commitments: [factory],
      }),
    ).toEqual([]);
    expect(
      projectMatureCommandIntents({
        ...base,
        capabilities: capabilities(),
        commitments: [
          {
            ...factory,
            objective: { ...factory.objective, mechanicsFingerprint: "stale" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("persists only OK attempts and settles exact next-observation factory and power deltas", () => {
    const commitments = [factoryCommitment(), powerCommitment()];
    const intents = projectMatureCommandIntents({
      capabilities: capabilities(),
      catalog: catalog(),
      commitments,
      snapshot: snapshot(),
      snapshotRevision: "revision/100",
    });
    const attempts = intents.map((intent) => required(createPendingMatureAttempt(intent, "OK")));
    expect(attempts.every(isPendingMatureAttempt)).toBe(true);
    expect(createPendingMatureAttempt(required(intents[0]), "ERR_TIRED")).toBeNull();

    const nextSnapshot = snapshot({
      factoryCooldown: 7,
      factoryResources: { energy: 0, silicon: 0, wire: 20 },
      powerResources: { energy: 350, power: 7 },
      tick: 101,
    });
    const result = reconcilePendingMatureAttempts({
      catalog: catalog(),
      commitments,
      pendingAttempts: [...attempts].reverse(),
      snapshot: nextSnapshot,
    });

    expect(result).toEqual([
      expect.objectContaining({
        kind: "factory",
        reason: "exact-effect",
        settledAmount: 20,
        status: "settled",
      }),
      expect.objectContaining({
        kind: "power-processing",
        reason: "exact-effect",
        settledAmount: 3,
        status: "settled",
      }),
    ]);
    expect(
      reconcilePendingMatureAttempts({
        catalog: catalog(),
        commitments: [],
        pendingAttempts: roundTrip([...attempts].reverse()),
        snapshot: roundTrip(nextSnapshot),
      }),
    ).toEqual(result);
  });

  it("rejects late or contaminated evidence instead of duplicating a scheduled command", () => {
    const commitments = [factoryCommitment(), powerCommitment()];
    const intents = projectMatureCommandIntents({
      capabilities: capabilities(),
      catalog: catalog(),
      commitments,
      snapshot: snapshot(),
      snapshotRevision: "revision/100",
    });
    const attempts = intents.map((intent) => required(createPendingMatureAttempt(intent, "OK")));
    const contaminated = reconcilePendingMatureAttempts({
      catalog: catalog(),
      commitments,
      pendingAttempts: [required(attempts.find(({ kind }) => kind === "factory"))],
      snapshot: snapshot({
        factoryCooldown: 7,
        factoryResources: { energy: 0, mist: 1, silicon: 0, wire: 20 },
        tick: 101,
      }),
    });
    expect(contaminated).toEqual([
      expect.objectContaining({ reason: "conflicting-effect", status: "cancelled" }),
    ]);

    const late = reconcilePendingMatureAttempts({
      catalog: catalog(),
      commitments,
      pendingAttempts: [required(attempts.find(({ kind }) => kind === "power-processing"))],
      snapshot: snapshot({ powerResources: { energy: 350, power: 7 }, tick: 102 }),
    });
    expect(late).toEqual([
      expect.objectContaining({ reason: "observation-timeout", status: "cancelled" }),
    ]);
  });

  it("suppresses pending or unfunded work and bounds or retires retries", () => {
    const commitments = [factoryCommitment(), powerCommitment()];
    const intents = projectMatureCommandIntents({
      capabilities: capabilities(),
      catalog: catalog(),
      commitments,
      snapshot: snapshot(),
      snapshotRevision: "revision/100",
    });
    const factoryAttempt = required(createPendingMatureAttempt(required(intents[0]), "OK", 2));
    expect(
      projectMatureCommandIntents({
        capabilities: capabilities(),
        catalog: catalog(),
        commitments,
        pendingAttempts: [factoryAttempt],
        snapshot: snapshot(),
        snapshotRevision: "revision/100",
      }).map(({ kind }) => kind),
    ).toEqual(["power-spawn.process-power"]);

    const unfunded: MaturePolicyCommitment[] = commitments.map((commitment) => ({
      objective: { ...commitment.objective, funded: false },
      status: "pending-funding",
    }));
    expect(
      projectMatureCommandIntents({
        capabilities: capabilities(),
        catalog: catalog(),
        commitments: unfunded,
        snapshot: snapshot(),
        snapshotRevision: "revision/100",
      }),
    ).toEqual([]);
    expect(
      reconcilePendingMatureAttempts({
        catalog: catalog(),
        commitments,
        pendingAttempts: [factoryAttempt],
        snapshot: snapshot({ tick: 101 }),
      }),
    ).toEqual([expect.objectContaining({ reason: "retry-cap", status: "cancelled" })]);

    const firstAttempt = required(createPendingMatureAttempt(required(intents[0]), "OK"));
    const retry = required(
      reconcilePendingMatureAttempts({
        catalog: catalog(),
        commitments,
        pendingAttempts: [firstAttempt],
        snapshot: snapshot({ tick: 101 }),
      })[0],
    );
    const retryReady = required(markMatureAttemptRetryReady(firstAttempt, retry));
    expect(
      reconcilePendingMatureAttempts({
        catalog: catalog(),
        commitments: unfunded,
        pendingAttempts: [retryReady],
        snapshot: snapshot({ tick: 102 }),
      }),
    ).toEqual([expect.objectContaining({ reason: "commitment-changed", status: "cancelled" })]);
  });
});

function catalog(): MatureMechanicsCatalog {
  const result = normalizeMatureMechanics({
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
    limits: {
      maximumCommodities: 8,
      maximumComponentsPerCommodity: 4,
      maximumResourceTypes: 16,
      maximumStringLength: 32,
    },
    resourceTypes: ["energy", "G", "power", "silicon", "wire"],
  });
  if (result.status !== "ready") throw new Error("fixture catalog must normalize");
  return result.catalog;
}

function capabilities(): readonly MatureStructureCapability[] {
  return [
    {
      active: true,
      availableProducts: ["wire"],
      cooldown: 0,
      effectLevels: [],
      fingerprint: "factory-capability",
      id: "factory",
      kind: "factory",
      level: null,
      processablePower: 0,
      range: 0,
      roomName: "W1N1",
      stocked: false,
      storeFingerprint: "factory-store",
    },
    {
      active: true,
      availableProducts: [],
      cooldown: 0,
      effectLevels: ["16:2:50"],
      fingerprint: "power-capability",
      id: "power-spawn",
      kind: "power-spawn",
      level: null,
      processablePower: 10,
      range: 0,
      roomName: "W1N1",
      stocked: false,
      storeFingerprint: "power-store",
    },
  ];
}

function factoryCommitment(): MaturePolicyCommitment {
  return {
    objective: {
      batches: 2,
      colonyId: "W1N1",
      deadline: 110,
      endpointId: "storage",
      funded: true,
      id: "mature:factory:W1N1:factory:wire",
      industryBudgetId: "industry:factory",
      kind: "factory-batch",
      mechanicsFingerprint: catalog().fingerprint,
      priority: "normal",
      product: "wire",
      revision: 1,
      structureId: "factory",
    },
    status: "ready",
  };
}

function powerCommitment(): MaturePolicyCommitment {
  return {
    objective: {
      colonyId: "W1N1",
      deadline: 110,
      endpointId: "storage",
      funded: true,
      id: "mature:power:W1N1:power-spawn",
      industryBudgetId: "industry:power",
      kind: "power-processing",
      mechanicsFingerprint: catalog().fingerprint,
      priority: "normal",
      revision: 1,
      structureId: "power-spawn",
      units: 10,
    },
    status: "ready",
  };
}

function snapshot(
  options: {
    readonly factoryCooldown?: number;
    readonly factoryResources?: Readonly<Record<string, number>>;
    readonly powerResources?: Readonly<Record<string, number>>;
    readonly tick?: number;
  } = {},
): WorldSnapshot {
  const tick = options.tick ?? 100;
  const room = {
    constructionSites: [],
    controller: {
      id: "controller",
      level: 8,
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: { roomName: "W1N1", x: 25, y: 25 },
      progress: 0,
      progressTotal: 1,
      reservationTicksToEnd: null,
      reservationUsername: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      ticksToDowngrade: 100_000,
      upgradeBlocked: null,
    },
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    name: "W1N1",
    observedAt: tick,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedFactories: [
      {
        active: true,
        cooldown: options.factoryCooldown ?? 0,
        effects: [],
        hits: 1_000,
        hitsMax: 1_000,
        id: "factory",
        level: null,
        pos: { roomName: "W1N1", x: 20, y: 20 },
        store: store(options.factoryResources ?? { energy: 40, silicon: 100 }),
      },
    ],
    ownedPowerSpawns: [
      {
        active: true,
        effects: [{ effect: 16, level: 2, ticksRemaining: 50 }],
        hits: 5_000,
        hitsMax: 5_000,
        id: "power-spawn",
        pos: { roomName: "W1N1", x: 21, y: 20 },
        store: store(options.powerResources ?? { energy: 500, power: 10 }),
      },
    ],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
  };
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    ownedRooms: [room],
    rooms: [room],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        hostileCreeps: 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        sources: 0,
        storedStructures: 0,
        total: 3,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected fixture value");
  return value;
}

function store(resources: Readonly<Record<string, number>>) {
  const entries = Object.entries(resources)
    .map(([resourceType, amount]) => ({ amount, resourceType }))
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const usedCapacity = entries.reduce((total, { amount }) => total + amount, 0);
  return {
    capacity: 50_000,
    freeCapacity: 50_000 - usedCapacity,
    resources: entries,
    usedCapacity,
  };
}
