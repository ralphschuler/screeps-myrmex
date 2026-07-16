import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import {
  authorizedCriticalMaintenance,
  planCriticalMaintenance,
  renewCriticalMaintenanceBudgets,
} from "../src/maintenance";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

describe("critical maintenance", () => {
  it("selects only a damaged spawn, sole container, and directly critical decaying road deterministically", () => {
    const config = buildRuntimeConfig({ policy: { repair: { maximumActiveContractsPerRoom: 3 } } });
    const first = planCriticalMaintenance(world(), config);
    const reordered = planCriticalMaintenance(world({ reorder: true }), config);

    expect(first.map(({ reason, targetId }) => [reason, targetId])).toEqual([
      ["spawn-loss", "spawn-a"],
      ["sole-container-loss", "container-a"],
      ["access-road-decay", "road-near"],
    ]);
    expect(reordered).toEqual(first);
    expect(
      first.every(({ targetId }) => !["wall-a", "rampart-a", "road-far"].includes(targetId)),
    ).toBe(true);
  });

  it("fails closed during a hostile threat and lets the budget/contract authorities clean up resolved work", () => {
    const config = buildRuntimeConfig();
    expect(planCriticalMaintenance(world({ hostile: true }), config)).toEqual([]);

    const candidates = renewCriticalMaintenanceBudgets(
      planCriticalMaintenance(world(), config),
      [],
      100,
      config.policy.leases.durationTicks,
      config.policy.leases.renewalWindowTicks,
    );
    const plan = authorizedCriticalMaintenance(
      candidates,
      candidates.map(({ budgetRequest }) => ({
        category: "critical-maintenance",
        colonyId: budgetRequest.colonyId,
        issuer: budgetRequest.issuer,
        status: "active" as const,
      })),
      { status: "ready", contracts: [] },
      100,
    );
    expect(plan.requests).toHaveLength(2);
    const spawnRequest = plan.requests.find(({ targetId }) => targetId === "spawn-a");
    expect(spawnRequest?.execution).toMatchObject({ action: "repair", completionHits: 4_000 });

    const cleanup = authorizedCriticalMaintenance(
      [],
      [],
      {
        status: "ready",
        contracts: [
          {
            budgetBinding: { category: "critical-maintenance", issuer: "maintenance/W1N1/spawn-a" },
            contractId: "contract-maintenance",
            execution: {
              action: "repair",
              completion: "work-complete",
              completionHits: 4_000,
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: "maintenance/W1N1/spawn-a",
            owner: { id: "W1N1", kind: "colony" },
            state: "active",
            targetId: "spawn-a",
          },
        ],
      },
      101,
    );
    expect(cleanup.transitions).toEqual([
      {
        contractId: "contract-maintenance",
        reason: "maintenance-target-resolved",
        tick: 101,
        to: "cancelled",
      },
    ]);
  });
});

function world(options: { hostile?: boolean; reorder?: boolean } = {}): WorldSnapshot {
  const store = { capacity: 2_000, freeCapacity: 2_000, resources: [], usedCapacity: 0 };
  const structures = [
    {
      hits: 100,
      hitsMax: 1_000,
      id: "container-a",
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: position(11, 10),
      store,
      structureType: "container",
    },
    {
      hits: 1,
      hitsMax: 1_000,
      id: "wall-a",
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: position(20, 20),
      store,
      structureType: "constructedWall",
    },
    {
      hits: 1,
      hitsMax: 1_000,
      id: "rampart-a",
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: position(21, 20),
      store,
      structureType: "rampart",
    },
  ];
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 100 },
    observedAt: 100,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: {
          id: "controller-a",
          level: 1,
          ownerUsername: "me",
          ownership: "owned",
          pos: position(10, 11),
          progress: 0,
          progressTotal: 100,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: 10_000,
          upgradeBlocked: null,
        },
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        hostileCreeps: options.hostile ? [hostile()] : [],
        name: "W1N1",
        observedAt: 100,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns: [
          {
            active: true,
            hits: 100,
            hitsMax: 5_000,
            id: "spawn-a",
            name: "Spawn1",
            pos: position(10, 10),
            spawning: null,
            store,
          },
        ],
        ownedTowers: [],
        roads: [
          { hits: 50, hitsMax: 5_000, id: "road-near", pos: position(10, 9), ticksToDecay: 900 },
          { hits: 1, hitsMax: 5_000, id: "road-far", pos: position(40, 40), ticksToDecay: 900 },
        ],
        sources: [
          {
            energy: 3_000,
            energyCapacity: 3_000,
            id: "source-a",
            pos: position(12, 10),
            ticksToRegeneration: null,
          },
        ],
        storedStructures: options.reorder ? structures.slice().reverse() : structures,
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        hostileCreeps: options.hostile ? 1 : 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 0,
        rooms: 1,
        sources: 1,
        storedStructures: 3,
        total: 6,
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
    id: "hostile-a",
    name: "hostile",
    ownerUsername: "enemy",
    pos: position(15, 15),
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 100,
  };
}
