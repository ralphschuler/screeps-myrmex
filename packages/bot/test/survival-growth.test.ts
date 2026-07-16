import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { authorizedSurvivalGrowth, planSurvivalGrowth, renewGrowthBudgets } from "../src/growth";
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
});

function world(
  options: { downgrade?: number; hostile?: boolean; sites?: boolean } = {},
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
          level: 1,
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
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        hostileCreeps: options.hostile ? [hostile()] : [],
        name: "W1N1",
        observedAt: 100,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns: [],
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
