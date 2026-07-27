import { describe, expect, it } from "vitest";
import {
  reconcileLeaseAgentActions,
  planLeaseAgents,
  type LeaseAgentPlanInput,
} from "../src/agents";
import { DEFAULT_SURVIVAL_POLICY } from "../src/config/defaults";
import type { LeasedWorkExecution } from "../src/contracts";
import { EMPTY_MOVEMENT_PROGRESS_VIEW, type LocalPathPlanningService } from "../src/movement";
import type { ControllerSnapshot, PositionSnapshot, WorldSnapshot } from "../src/world/snapshot";

const paths: LocalPathPlanningService = {
  plan: ({ goal }) => ({
    cost: 1,
    directions: [goal.x > 10 ? 3 : 7],
    source: "search",
    status: "ready",
  }),
};

describe("remote reservation lease execution", () => {
  it("uses the immutable room route to approach and cross the canonical local exit", () => {
    const approaching = plan(snapshot(position("W1N1", 10, 10)), reservationLease());
    const crossing = plan(snapshot(position("W1N1", 49, 10)), reservationLease());

    expect(approaching.dispositions).toEqual([]);
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
  });

  it("signs once while assigned, then reserves through one primary action per tick", () => {
    const world = snapshot(position("W0N1", 24, 25), controller());
    const assigned = plan(world, reservationLease());
    const active = plan(world, reservationLease({ state: "active" }));

    expect(assigned.actions).toEqual([
      expect.objectContaining({
        kind: "sign-controller",
        targetId: "controller-a",
        text: "MYRMEX",
      }),
    ]);
    expect(active.actions).toEqual([
      expect.objectContaining({ kind: "reserve-controller", targetId: "controller-a" }),
    ]);
    expect(assigned.movement).toEqual([]);
    expect(active.movement).toEqual([]);
  });

  it("turns an issued out-of-range rejection into bounded retry evidence", () => {
    const lease = reservationLease({ state: "active" });
    const intent = {
      actorId: "creep-a",
      amount: null,
      contractId: lease.contractId,
      contractRevision: lease.revision,
      deadline: 500,
      id: "reserve",
      kind: "reserve-controller" as const,
      priority: 800,
      resourceType: null,
      targetId: "controller-a",
    };
    expect(
      reconcileLeaseAgentActions(
        [lease],
        {
          actionDecisions: [],
          actionExecution: [
            {
              intent,
              outcome: { code: -9, name: "ERR_NOT_IN_RANGE", state: "game-rejected" },
              reason: "out-of-range",
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
      { contractId: "reservation-a", reason: "agent-out-of-range", tick: 10, to: "suspended" },
    ]);
  });

  it("fails closed after CLAIM loss, route drift, or foreign controller reservation", () => {
    const noClaim = snapshot(position("W0N1", 24, 25), controller(), false);
    const foreign = snapshot(
      position("W0N1", 24, 25),
      controller({
        ownership: "reserved",
        reservationUsername: "other",
        reservationTicksToEnd: 500,
      }),
    );
    const drifted = snapshot(position("W9N9", 10, 10));

    expect(plan(noClaim, reservationLease()).dispositions[0]?.reason).toBe("actor-capability-lost");
    expect(plan(foreign, reservationLease()).dispositions[0]?.reason).toBe("controller-blocked");
    expect(plan(drifted, reservationLease()).dispositions[0]?.reason).toBe("route-unavailable");
  });
});

function plan(snapshot: WorldSnapshot, lease: LeasedWorkExecution) {
  const input: LeaseAgentPlanInput = {
    availablePathCpu: 1,
    execution: { leases: [lease], status: "ready" },
    movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
    paths,
    progress: EMPTY_MOVEMENT_PROGRESS_VIEW,
    snapshot,
    tick: 10,
  };
  return planLeaseAgents(input);
}
function reservationLease(overrides: Partial<LeasedWorkExecution> = {}): LeasedWorkExecution {
  return {
    actorId: "creep-a",
    actorName: "reserver",
    contractId: "reservation-a",
    deadline: 500,
    execution: {
      action: "reserve-controller",
      completion: "work-complete",
      counterpartId: null,
      originRoomName: "W1N1",
      resourceType: null,
      routeRoomNames: ["W0N1"],
      routeTravelTicks: 50,
      signText: "MYRMEX",
      targetReservationTicks: 450,
      version: 4,
    },
    expiresAt: 501,
    leaseExpiresAt: 501,
    priority: { class: "speculation", value: 800 },
    quantity: 450,
    range: 1,
    revision: 1,
    state: "assigned",
    target: position("W0N1", 25, 25),
    targetId: "controller-a",
    ...overrides,
  };
}
function position(roomName: string, x: number, y: number): PositionSnapshot {
  return { roomName, x, y };
}
function controller(overrides: Partial<ControllerSnapshot> = {}): ControllerSnapshot {
  return {
    id: "controller-a",
    level: 0,
    ownerUsername: null,
    ownership: "neutral",
    pos: position("W0N1", 25, 25),
    progress: null,
    progressTotal: null,
    reservationTicksToEnd: null,
    reservationUsername: null,
    safeMode: null,
    safeModeAvailable: 0,
    safeModeCooldown: null,
    ticksToDowngrade: null,
    upgradeBlocked: null,
    ...overrides,
  };
}
function snapshot(
  actorPos: PositionSnapshot,
  target: ControllerSnapshot | null = null,
  claim = true,
): WorldSnapshot {
  const rooms = ["W1N1", "W0N1", "W9N9"].map((name) => ({
    constructionSites: [],
    controller: target?.pos.roomName === name ? target : null,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    hostileCreeps: [],
    exits: name === "W1N1" ? [position(name, 49, 10)] : [],
    name,
    observedAt: 10,
    ownedCreeps: actorPos.roomName === name ? [creep(actorPos, claim)] : [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    sources: [],
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
        controllers: target === null ? 0 : 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: rooms.length,
        ruins: 0,
        sources: 0,
        storedStructures: 0,
        tombstones: 0,
        total: target === null ? 1 : 2,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}
function creep(pos: PositionSnapshot, claim: boolean) {
  const zero = { active: 0, boosted: 0, total: 0 };
  return {
    body: {
      activeParts: claim ? 4 : 2,
      attack: zero,
      carry: zero,
      claim: { ...zero, active: claim ? 2 : 0, total: claim ? 2 : 0 },
      heal: zero,
      move: { ...zero, active: 2, total: 2 },
      rangedAttack: zero,
      size: claim ? 4 : 2,
      tough: zero,
      work: zero,
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: "creep-a",
    name: "reserver",
    ownerUsername: "me",
    pos,
    spawning: false,
    store: { capacity: 0, freeCapacity: 0, resources: [], usedCapacity: 0 },
    ticksToLive: 500,
  };
}
