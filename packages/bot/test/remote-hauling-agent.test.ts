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

describe("routed remote hauling lease", () => {
  it("follows acquisition and delivery routes through the sole action path", () => {
    expect(plan(snapshot(pos("W1N1", 10, 10), 0), lease("acquire")).movement[0]).toMatchObject({
      goal: pos("W1N1", 49, 10),
    });
    expect(plan(snapshot(pos("W1N1", 49, 10), 0), lease("acquire")).movement[0]).toMatchObject({
      destination: pos("W0N1", 0, 10),
      roomTransition: true,
    });
    expect(plan(snapshot(pos("W0N1", 9, 10), 0), lease("acquire")).actions).toEqual([
      expect.objectContaining({ amount: 800, kind: "withdraw", targetId: "container-a" }),
    ]);
    expect(plan(snapshot(pos("W0N1", 10, 10), 700), lease("deliver")).movement[0]).toMatchObject({
      goal: pos("W0N1", 0, 10),
    });
    expect(plan(snapshot(pos("W1N1", 19, 20), 700), lease("deliver")).actions).toEqual([
      expect.objectContaining({ amount: 700, kind: "transfer", targetId: "storage-a" }),
    ]);
  });

  it("turns an expected command rejection into one bounded suspension", () => {
    const value = lease("acquire");
    const intent = plan(snapshot(pos("W0N1", 9, 10), 0), value).actions[0];
    if (intent === undefined) throw new Error("expected withdraw intent");
    expect(
      reconcileLeaseAgentActions(
        [value],
        {
          actionDecisions: [],
          actionExecution: [
            {
              intent,
              outcome: { code: -6, name: "ERR_NOT_ENOUGH_RESOURCES", state: "game-rejected" },
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
        100,
      ),
    ).toEqual([
      {
        contractId: "remote-haul-acquire",
        reason: "agent-unexpected-game-rejection",
        tick: 100,
        to: "suspended",
      },
    ]);
  });

  it("fails closed on route drift and a full sink", () => {
    expect(plan(snapshot(pos("W9N9", 10, 10), 0), lease("acquire")).dispositions[0]?.reason).toBe(
      "route-unavailable",
    );
    const full = plan(snapshot(pos("W1N1", 19, 20), 700, true), lease("deliver"));
    expect(full.actions).toEqual([]);
    expect(full.dispositions[0]?.reason).toBe("target-full");
  });
});

function plan(snapshot: WorldSnapshot, value: LeasedWorkExecution) {
  const input: LeaseAgentPlanInput = {
    availablePathCpu: 1,
    execution: { leases: [value], status: "ready" },
    movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
    paths,
    progress: EMPTY_MOVEMENT_PROGRESS_VIEW,
    snapshot,
    tick: 100,
  };
  return planLeaseAgents(input);
}
function lease(stage: "acquire" | "deliver"): LeasedWorkExecution {
  const acquire = stage === "acquire";
  return {
    actorId: "hauler-a",
    actorName: "hauler-a",
    contractId: `remote-haul-${stage}`,
    deadline: 500,
    execution: {
      acquireOriginRoomName: "W1N1",
      acquireRouteRoomNames: ["W0N1"],
      acquireRouteTravelTicks: 40,
      action: acquire ? "withdraw" : "transfer",
      completion: acquire ? "target-depleted" : "target-full",
      counterpartId: acquire ? "storage-a" : "container-a",
      deliverOriginRoomName: "W0N1",
      deliverRouteRoomNames: ["W1N1"],
      deliverRouteTravelTicks: 40,
      flowId: "remote-haul-flow-a",
      recommendedCarry: 16,
      recommendedMove: 16,
      reservedAmount: 800,
      resourceType: "energy",
      sinkBaselineAmount: 5_000,
      sinkNodeId: "sink-a",
      sinkPosition: pos("W1N1", 20, 20),
      sinkTargetId: "storage-a",
      sourceNodeId: "source-a",
      sourcePosition: pos("W0N1", 10, 10),
      sourceTargetId: "container-a",
      stage,
      version: 6,
    },
    expiresAt: 501,
    leaseExpiresAt: 501,
    priority: { class: "speculation", value: 700 },
    quantity: 800,
    range: 1,
    revision: 1,
    state: "active",
    target: acquire ? pos("W0N1", 10, 10) : pos("W1N1", 20, 20),
    targetId: acquire ? "container-a" : "storage-a",
  };
}
function snapshot(actorPos: PositionSnapshot, cargo: number, full = false): WorldSnapshot {
  const rooms = ["W1N1", "W0N1", "W9N9"].map((name) => ({
    constructionSites: [],
    controller: null,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    exits: name === "W1N1" ? [pos(name, 49, 10)] : name === "W0N1" ? [pos(name, 0, 10)] : [],
    name,
    observedAt: 100,
    ownedCreeps: actorPos.roomName === name ? [creep(actorPos, cargo)] : [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [],
    storedStructures:
      name === "W0N1"
        ? [structure("container-a", name, 10, 10, 2_000, 800, "unowned")]
        : name === "W1N1"
          ? [structure("storage-a", name, 20, 20, 1_000_000, full ? 1_000_000 : 5_000, "owned")]
          : [],
    traversal: { revision: `traversal/${name}`, walkability: ".".repeat(2_500) },
  }));
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 100 },
    observedAt: 100,
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
        rooms: 3,
        ruins: 0,
        sources: 0,
        storedStructures: 2,
        tombstones: 0,
        total: 3,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}
function creep(position: PositionSnapshot, cargo: number) {
  const zero = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: 32,
      attack: zero,
      carry: { active: 16, boosted: 0, total: 16 },
      claim: zero,
      heal: zero,
      move: { active: 16, boosted: 0, total: 16 },
      rangedAttack: zero,
      size: 32,
      tough: zero,
      work: zero,
    },
    fatigue: 0,
    hits: 3_200,
    hitsMax: 3_200,
    id: "hauler-a",
    name: "hauler-a",
    ownerUsername: "self",
    pos: position,
    spawning: false,
    store: {
      capacity: 800,
      freeCapacity: 800 - cargo,
      resources: cargo === 0 ? [] : [{ amount: cargo, resourceType: "energy" as ResourceConstant }],
      usedCapacity: cargo,
    },
    ticksToLive: 1_000,
  };
}
function structure(
  id: string,
  roomName: string,
  x: number,
  y: number,
  capacity: number,
  energy: number,
  ownership: "owned" | "unowned",
) {
  return {
    hits: 250_000,
    hitsMax: 250_000,
    id,
    ownerUsername: ownership === "owned" ? "self" : null,
    ownership,
    pos: pos(roomName, x, y),
    store: {
      capacity,
      freeCapacity: capacity - energy,
      resources: [{ amount: energy, resourceType: "energy" as ResourceConstant }],
      usedCapacity: energy,
    },
    structureType: id.startsWith("storage") ? "storage" : "container",
    ticksToDecay: id.startsWith("storage") ? null : 100,
  };
}
function pos(roomName: string, x: number, y: number): PositionSnapshot {
  return { roomName, x, y };
}
