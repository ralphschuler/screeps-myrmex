import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { authorizedSurvivalGrowth, planSurvivalGrowth, renewGrowthBudgets } from "../src/growth";
import type { ContractPlanningView } from "../src/contracts";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

describe("survival growth", () => {
  it("prioritizes downgrade-risk upgrading ahead of existing critical construction", () => {
    const config = buildRuntimeConfig();
    const planned = planSurvivalGrowth(world({ downgrade: 10, sites: true }), config);
    expect(
      planned.map(({ action, budgetRequest, targetId }) => [
        action,
        budgetRequest.category,
        targetId,
      ]),
    ).toEqual([
      ["upgrade-controller", "controller-risk", "controller-a"],
      ["build", "optional-growth", "site-spawn"],
      ["build", "optional-growth", "site-road"],
    ]);
  });

  it("uses only funded candidates and cancels a vanished completed site", () => {
    const config = buildRuntimeConfig();
    const candidates = renewGrowthBudgets(
      planSurvivalGrowth(world({ sites: true }), config),
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const funded = authorizedSurvivalGrowth(
      candidates,
      candidates.map(({ budgetRequest }) => ({
        category: budgetRequest.category,
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active" as const,
      })),
      { status: "ready", contracts: [] },
      100,
    );
    expect(funded.requests.map(({ execution }) => execution?.action)).toEqual(["build", "build"]);

    const cleanup = authorizedSurvivalGrowth(
      [],
      [],
      {
        status: "ready",
        contracts: [
          {
            budgetBinding: { category: "optional-growth", issuer: "growth/W1N1/build/site-spawn" },
            contractId: "contract-site",
            execution: {
              action: "build",
              completion: "work-complete",
              completionHits: null,
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: "growth/W1N1/build/site-spawn",
            owner: { id: "W1N1", kind: "colony" },
            state: "active",
            targetId: "site-spawn",
          },
        ],
      },
      101,
    );
    expect(cleanup.transitions).toEqual([
      { contractId: "contract-site", reason: "growth-target-resolved", tick: 101, to: "cancelled" },
    ]);
  });

  it("does not create placement work and suppresses growth during a present hostile", () => {
    const config = buildRuntimeConfig();
    expect(planSurvivalGrowth(world({ hostile: true }), config)).toEqual([]);
    expect(
      planSurvivalGrowth(world(), config).every(({ action }) => action === "upgrade-controller"),
    ).toBe(true);
  });

  it("bridges RCL1 only from carried energy after the 300-energy spawn reserve is full", () => {
    const config = buildRuntimeConfig();
    const planned = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 1,
      }),
      config,
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      action: "upgrade-controller",
      reasonCode: "rcl1-bootstrap-controller",
      budgetRequest: {
        category: "bootstrap-controller",
        energy: null,
      },
    });
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          energy: 299,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 1,
        }),
        config,
      ),
    ).toEqual([]);
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 1,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 0,
        }),
        config,
      ),
    ).toEqual([]);
    expect(
      planSurvivalGrowth(
        world({
          controllerLevel: 2,
          energy: 300,
          energyCapacity: 300,
          spawn: true,
          workerEnergy: 1,
        }),
        config,
      ),
    ).toEqual([]);
  });

  it("keeps bootstrap demand reusable across temporary infeasibility and cancels when bootstrap phase exits", () => {
    const config = buildRuntimeConfig();
    const candidates = planSurvivalGrowth(
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 1,
      }),
      config,
    );
    const bootstrap = candidates.find(
      ({ budgetRequest }) => budgetRequest.category === "bootstrap-controller",
    );
    if (bootstrap === undefined) {
      throw new Error("expected bootstrap candidate");
    }
    const planning: ContractPlanningView = {
      status: "ready" as const,
      contracts: [
        {
          budgetBinding: {
            category: "bootstrap-controller",
            issuer: bootstrap.budgetRequest.issuer,
          },
          contractId: "bootstrap-RCL1",
          execution: {
            action: "upgrade-controller" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: null,
            version: 1,
          },
          issuer: bootstrap.budgetRequest.issuer,
          owner: { id: "W1N1", kind: "colony" },
          state: "funded" as const,
          targetId: bootstrap.targetId,
        },
      ],
    };

    const transitionsDuringTemporaryHiccup = authorizedSurvivalGrowth(
      [],
      [],
      planning,
      110,
      world({
        controllerLevel: 1,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 0,
      }),
    ).transitions;
    expect(transitionsDuringTemporaryHiccup).toEqual([]);

    const transitionsAfterBootstrapPhase = authorizedSurvivalGrowth(
      [],
      [],
      planning,
      111,
      world({
        controllerLevel: 2,
        energy: 300,
        energyCapacity: 300,
        spawn: true,
        workerEnergy: 0,
      }),
    ).transitions;
    expect(transitionsAfterBootstrapPhase).toEqual([
      expect.objectContaining({
        contractId: "bootstrap-RCL1",
        reason: "growth-target-resolved",
        tick: 111,
        to: "cancelled",
      }),
    ]);
  });
});

function world(
  options: {
    controllerLevel?: number;
    downgrade?: number;
    energy?: number;
    energyCapacity?: number;
    hostile?: boolean;
    sites?: boolean;
    spawn?: boolean;
    workerEnergy?: number;
  } = {},
): WorldSnapshot {
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 100 },
    observedAt: 100,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: options.sites
          ? [
              {
                id: "site-road",
                ownerUsername: "me",
                ownership: "owned",
                pos: position(11, 10),
                progress: 0,
                progressTotal: 100,
                structureType: "road",
              },
              {
                id: "site-spawn",
                ownerUsername: "me",
                ownership: "owned",
                pos: position(12, 10),
                progress: 0,
                progressTotal: 100,
                structureType: "spawn",
              },
            ]
          : [],
        controller: {
          id: "controller-a",
          level: options.controllerLevel ?? 1,
          ownerUsername: "me",
          ownership: "owned",
          pos: position(10, 10),
          progress: 0,
          progressTotal: 100,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: options.downgrade ?? 10_000,
          upgradeBlocked: null,
        },
        energyAvailable: options.energy ?? 800,
        energyCapacityAvailable: options.energyCapacity ?? 800,
        hostileCreeps: options.hostile ? [hostile()] : [],
        name: "W1N1",
        observedAt: 100,
        ownedCreeps:
          options.workerEnergy === undefined ? [] : [worker(options.workerEnergy, position(9, 10))],
        ownedExtensions: [],
        ownedSpawns: options.spawn ? [spawn()] : [],
        ownedTowers: [],
        roads: [],
        sources: [],
        storedStructures: [],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: options.sites ? 2 : 0,
        controllers: 1,
        hostileCreeps: options.hostile ? 1 : 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        sources: 0,
        storedStructures: 0,
        total: 2,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}
function spawn() {
  return {
    active: true,
    hits: 5_000,
    hitsMax: 5_000,
    id: "spawn-a",
    name: "Spawn1",
    pos: position(5, 5),
    spawning: null,
    store: { capacity: 300, freeCapacity: 0, resources: [], usedCapacity: 300 },
  };
}
function worker(carriedEnergy: number, pos: ReturnType<typeof position>) {
  const none = { active: 0, boosted: 0, total: 0 };
  const one = { active: 1, boosted: 0, total: 1 };
  return {
    body: {
      activeParts: 3,
      attack: none,
      carry: one,
      claim: none,
      heal: none,
      move: one,
      rangedAttack: none,
      size: 3,
      tough: none,
      work: one,
    },
    fatigue: 0,
    hits: 300,
    hitsMax: 300,
    id: "worker",
    name: "worker",
    ownerUsername: "me",
    pos,
    spawning: false,
    store: {
      capacity: 50,
      freeCapacity: 50 - carriedEnergy,
      resources: carriedEnergy === 0 ? [] : [{ amount: carriedEnergy, resourceType: "energy" }],
      usedCapacity: carriedEnergy,
    },
    ticksToLive: 1_000,
  };
}
function hostile() {
  const none = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 1,
      attack: { active: 1, boosted: 0, total: 1 },
      carry: none,
      claim: none,
      heal: none,
      move: none,
      rangedAttack: none,
      size: 1,
      tough: none,
      work: none,
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: "hostile",
    name: "hostile",
    ownerUsername: "enemy",
    pos: position(20, 20),
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 100,
  };
}
