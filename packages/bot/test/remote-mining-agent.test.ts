import { describe, expect, it } from "vitest";
import {
  planLeaseAgents,
  reconcileLeaseAgentActions,
  type LeaseAgentPlanInput,
} from "../src/agents";
import { DEFAULT_SURVIVAL_POLICY } from "../src/config/defaults";
import type { LeasedWorkExecution } from "../src/contracts";
import { EMPTY_MOVEMENT_PROGRESS_VIEW, type LocalPathPlanningService } from "../src/movement";
import type { PositionSnapshot, WorldSnapshot } from "../src/world/snapshot";

const paths: LocalPathPlanningService = {
  plan: ({ goal }) => ({
    cost: 1,
    directions: [goal.x > 10 ? 3 : 7],
    source: "search",
    status: "ready",
  }),
};

describe("remote mining lease execution", () => {
  it("uses the immutable route, then harvests from its exact static position", () => {
    const approaching = plan(snapshot(position("W1N1", 10, 10)), miningLease());
    const crossing = plan(snapshot(position("W1N1", 49, 10)), miningLease());
    const harvesting = plan(
      snapshot(position("W0N1", 9, 9), { energy: 3_000, present: true }),
      miningLease(),
    );

    expect(approaching.movement).toEqual([
      expect.objectContaining({
        destination: position("W1N1", 11, 10),
        goal: position("W1N1", 49, 10),
        direction: 3,
      }),
    ]);
    expect(crossing.movement).toEqual([
      expect.objectContaining({
        destination: position("W0N1", 0, 10),
        goal: position("W0N1", 0, 10),
        direction: 3,
      }),
    ]);
    expect(harvesting.dispositions).toEqual([]);
    expect(harvesting.actions).toEqual([
      expect.objectContaining({ kind: "harvest", targetId: "source-a" }),
    ]);
  });

  it("continues with zero CARRY or a full store and idles while the source regenerates", () => {
    const full = plan(
      snapshot(position("W0N1", 9, 9), { energy: 3_000, present: true }, true),
      miningLease(),
    );
    const regenerating = plan(
      snapshot(position("W0N1", 9, 9), { energy: 0, present: true }, true),
      miningLease(),
    );

    expect(full.actions).toHaveLength(1);
    expect(full.dispositions).toEqual([]);
    expect(regenerating.actions).toEqual([]);
    expect(regenerating.dispositions).toEqual([]);
  });

  it("suspends on route drift, source loss, or an issued command rejection", () => {
    expect(plan(snapshot(position("W9N9", 10, 10)), miningLease()).dispositions[0]?.reason).toBe(
      "route-unavailable",
    );
    expect(
      plan(snapshot(position("W0N1", 9, 9), { energy: 0, present: false }), miningLease())
        .dispositions[0]?.reason,
    ).toBe("target-missing");

    const lease = miningLease();
    const intent = {
      actorId: lease.actorId,
      amount: lease.quantity,
      contractId: lease.contractId,
      contractRevision: lease.revision,
      deadline: 500,
      id: "harvest",
      kind: "harvest" as const,
      priority: 700,
      resourceType: null,
      targetId: lease.targetId,
    };
    expect(
      reconcileLeaseAgentActions(
        [lease],
        {
          actionDecisions: [],
          actionExecution: [
            {
              intent,
              outcome: { code: -1, name: "ERR_NOT_OWNER", state: "game-rejected" },
              reason: "unexpected-game-rejection",
              status: "rejected",
            },
          ],
          actionSubmitted: 1,
          movementDecisions: [],
          movementExecution: [],
          movementSubmitted: 0,
          status: "executed",
        },
        10,
      ),
    ).toEqual([
      {
        contractId: "remote-mining-a",
        reason: "agent-unexpected-game-rejection",
        tick: 10,
        to: "suspended",
      },
    ]);
  });
});

function plan(snapshotValue: WorldSnapshot, lease: LeasedWorkExecution) {
  const input: LeaseAgentPlanInput = {
    availablePathCpu: 1,
    execution: { leases: [lease], status: "ready" },
    movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
    paths,
    progress: EMPTY_MOVEMENT_PROGRESS_VIEW,
    snapshot: snapshotValue,
    tick: 10,
  };
  return planLeaseAgents(input);
}

function miningLease(): LeasedWorkExecution {
  return {
    actorId: "creep-a",
    actorName: "miner",
    contractId: "remote-mining-a",
    deadline: 500,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      offload: "container-or-drop",
      originRoomName: "W1N1",
      resourceType: null,
      routeRoomNames: ["W0N1"],
      routeTravelTicks: 50,
      version: 5,
      workPosition: position("W0N1", 9, 9),
    },
    expiresAt: 501,
    leaseExpiresAt: 501,
    priority: { class: "speculation", value: 700 },
    quantity: 300,
    range: 1,
    revision: 1,
    state: "active",
    target: position("W0N1", 10, 10),
    targetId: "source-a",
  };
}

function snapshot(
  actorPos: PositionSnapshot,
  source: { readonly energy: number; readonly present: boolean } | null = null,
  fullStore = false,
): WorldSnapshot {
  const rooms = ["W1N1", "W0N1", "W9N9"].map((name) => ({
    constructionSites: [],
    controller: null,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    exits: name === "W1N1" ? [position(name, 49, 10)] : [],
    name,
    observedAt: 10,
    ownedCreeps: actorPos.roomName === name ? [creep(actorPos, fullStore)] : [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources:
      name === "W0N1" && source?.present === true
        ? [
            {
              energy: source.energy,
              energyCapacity: 3_000,
              id: "source-a",
              pos: position("W0N1", 10, 10),
              ticksToRegeneration: source.energy === 0 ? 100 : null,
            },
          ]
        : [],
    storedStructures: [],
    traversal: { revision: `traversal/${name}`, walkability: ".".repeat(2_500) },
  }));
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 0,
    ownedRooms: [],
    rooms,
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 0,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: rooms.length,
        ruins: 0,
        sources: source?.present === true ? 1 : 0,
        storedStructures: 0,
        tombstones: 0,
        total: source?.present === true ? 2 : 1,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function creep(pos: PositionSnapshot, fullStore: boolean) {
  const zero = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 10,
      attack: zero,
      carry: zero,
      claim: zero,
      heal: zero,
      move: { active: 5, boosted: 0, total: 5 },
      rangedAttack: zero,
      size: 10,
      tough: zero,
      work: { active: 5, boosted: 0, total: 5 },
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: "creep-a",
    name: "miner",
    ownerUsername: "me",
    pos,
    spawning: false,
    store: fullStore
      ? {
          capacity: 50,
          freeCapacity: 0,
          resources: [{ amount: 50, resourceType: "energy" as ResourceConstant }],
          usedCapacity: 50,
        }
      : { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 1_000,
  };
}

function position(roomName: string, x: number, y: number): PositionSnapshot {
  return { roomName, x, y };
}
