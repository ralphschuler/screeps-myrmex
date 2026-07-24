import { describe, expect, it } from "vitest";
import { dispositionTransitions, planLeaseAgents } from "../src/agents";
import { CacheManager } from "../src/cache";
import { DEFAULT_SURVIVAL_POLICY } from "../src/config/defaults";
import type { LeasedWorkExecution } from "../src/contracts";
import {
  getMovementProgressTracker,
  type LocalPathPlanningService,
  type MovementIntent,
  type MovementRuntimeResult,
} from "../src/movement";
import type { PositionSnapshot, WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number): PositionSnapshot => ({ roomName: "W1N1", x, y });

const lease: LeasedWorkExecution = {
  actorId: "worker-a",
  actorName: "worker",
  contractId: "build-a",
  deadline: 50,
  execution: {
    action: "build",
    completion: "work-complete",
    counterpartId: null,
    resourceType: null,
    version: 1,
  },
  expiresAt: 51,
  leaseExpiresAt: 51,
  priority: { class: "growth", value: 10 },
  quantity: 100,
  range: 3,
  revision: 2,
  state: "assigned",
  target: position(15, 10),
  targetId: "site-a",
};

const paths: LocalPathPlanningService = {
  plan: (request) => {
    if (request.bypassCache === true) {
      return { cost: 1, directions: [1], source: "search", status: "ready" };
    }
    return {
      cost: 1,
      directions: [request.origin.y === 9 ? 4 : 3],
      source: "cache",
      status: "ready",
    };
  },
};

describe("leased movement blockage recovery", () => {
  it("routes around temporary occupancy and reaches the existing build action", () => {
    const progress = getMovementProgressTracker(new CacheManager());
    let actor = position(10, 10);
    let blocker = true;
    let plan = planAt(10, actor, blocker, progress);

    for (const tick of [10, 11, 12]) {
      if (tick !== 10) plan = planAt(tick, actor, blocker, progress);
      expect(plan.movement).toHaveLength(1);
      expect(plan.movement[0]?.destination).toEqual(position(11, 10));
      progress.record(
        movementResult(plan.movement[0] as MovementIntent),
        snapshot(actor, blocker),
        tick,
      );
    }

    plan = planAt(13, actor, blocker, progress);
    expect(plan.movement[0]).toMatchObject({
      destination: position(10, 9),
      direction: 1,
      stuckAge: DEFAULT_SURVIVAL_POLICY.movement.stuckReplanTicks,
    });
    progress.record(
      movementResult(plan.movement[0] as MovementIntent),
      snapshot(actor, blocker),
      13,
    );

    actor = position(10, 9);
    blocker = false;
    plan = planAt(14, actor, blocker, progress);
    expect(plan.movement[0]).toMatchObject({ destination: position(11, 10), stuckAge: 0 });
    progress.record(
      movementResult(plan.movement[0] as MovementIntent),
      snapshot(actor, blocker),
      14,
    );

    actor = position(11, 10);
    plan = planAt(15, actor, blocker, progress);
    expect(plan.movement[0]).toMatchObject({ destination: position(12, 10), stuckAge: 0 });
    progress.record(
      movementResult(plan.movement[0] as MovementIntent),
      snapshot(actor, blocker),
      15,
    );

    actor = position(12, 10);
    plan = planAt(16, actor, blocker, progress);
    expect(plan.movement).toEqual([]);
    expect(plan.actions).toEqual([
      expect.objectContaining({ actorId: "worker-a", contractId: "build-a", kind: "build" }),
    ]);
  });

  it("keeps the safe cached move when optional replan CPU is denied", () => {
    const cpuDeniedPaths: LocalPathPlanningService = {
      plan: (request) =>
        request.bypassCache === true
          ? { reason: "cpu-budget", status: "deferred" }
          : { cost: 1, directions: [3], source: "cache", status: "ready" },
    };
    const plan = planLeaseAgents({
      availablePathCpu: 0,
      execution: { leases: [lease], status: "ready" },
      movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
      paths: cpuDeniedPaths,
      progress: { stuckAge: () => DEFAULT_SURVIVAL_POLICY.movement.stuckReplanTicks },
      snapshot: snapshot(position(10, 10), true),
      tick: 13,
    });

    expect(plan.movement[0]).toMatchObject({
      destination: position(11, 10),
      direction: 3,
      stuckAge: DEFAULT_SURVIVAL_POLICY.movement.stuckReplanTicks,
    });
  });

  it("canonically overlays current occupancy and earlier proposed destinations", () => {
    const base = snapshot(position(10, 10), true);
    const room = base.rooms[0];
    if (room === undefined) throw new Error("missing room");
    const siteB = {
      id: "site-b",
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: position(15, 12),
      progress: 0,
      progressTotal: 100,
      structureType: "extension",
    };
    const world = {
      ...base,
      rooms: [{ ...room, constructionSites: [...room.constructionSites, siteB] }],
    };
    const dynamicCalls: PositionSnapshot[][] = [];
    const observingPaths: LocalPathPlanningService = {
      plan: (request) => {
        if (request.bypassCache === true) dynamicCalls.push([...(request.blockedPositions ?? [])]);
        return {
          cost: 1,
          directions: [request.bypassCache === true ? 1 : 3],
          source: request.bypassCache === true ? "search" : "cache",
          status: "ready",
        };
      },
    };
    const blockerLease: LeasedWorkExecution = {
      ...lease,
      actorId: "blocker-a",
      actorName: "blocker",
      contractId: "build-b",
      target: position(15, 12),
      targetId: "site-b",
    };

    planLeaseAgents({
      availablePathCpu: 2,
      execution: { leases: [lease, blockerLease], status: "ready" },
      movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
      paths: observingPaths,
      progress: { stuckAge: () => DEFAULT_SURVIVAL_POLICY.movement.stuckReplanTicks },
      snapshot: world,
      tick: 13,
    });

    expect(dynamicCalls).toEqual([[position(10, 10)], [position(11, 9), position(11, 10)]]);
  });

  it("keeps reordered congestion evidence equivalent while an empty heap only restarts age", () => {
    const orderedProgress = getMovementProgressTracker(new CacheManager());
    const reversedProgress = getMovementProgressTracker(new CacheManager());
    const actor = position(10, 10);
    const base = planAt(12, actor, true, orderedProgress).movement[0] as MovementIntent;
    const attempt = {
      ...base,
      stuckAge: DEFAULT_SURVIVAL_POLICY.movement.stuckReplanTicks - 1,
    };
    orderedProgress.record(movementResult(attempt), snapshot(actor, true), 12);
    reversedProgress.record(movementResult(attempt), snapshot(actor, true, true), 12);

    expect(planAt(13, actor, true, orderedProgress)).toEqual(
      planAt(13, actor, true, reversedProgress, true),
    );
    expect(
      planAt(13, actor, true, getMovementProgressTracker(new CacheManager())).movement[0],
    ).toMatchObject({ destination: position(11, 10), stuckAge: 0 });
  });

  it("suspends one exact lease at the bounded no-progress threshold", () => {
    const progress = getMovementProgressTracker(new CacheManager());
    const actor = position(10, 10);
    const initial = planAt(30, actor, true, progress);
    const attempted = {
      ...(initial.movement[0] as MovementIntent),
      stuckAge: DEFAULT_SURVIVAL_POLICY.movement.blockedReleaseTicks - 1,
    };
    progress.record(movementResult(attempted), snapshot(actor, true), 30);

    const blocked = planAt(31, actor, true, progress);
    expect(blocked.actions).toEqual([]);
    expect(blocked.movement).toEqual([]);
    expect(blocked.dispositions).toEqual([
      {
        contractId: "build-a",
        contractRevision: 2,
        reason: "movement-blocked",
        to: "suspended",
      },
    ]);
    expect(dispositionTransitions(blocked.dispositions, 31)).toEqual([
      {
        contractId: "build-a",
        reason: "agent-movement-blocked",
        tick: 31,
        to: "suspended",
      },
    ]);
  });
});

function planAt(
  tick: number,
  actor: PositionSnapshot,
  blocker: boolean,
  progress: ReturnType<typeof getMovementProgressTracker>,
  reverseCreeps = false,
) {
  return planLeaseAgents({
    availablePathCpu: 1,
    execution: { leases: [lease], status: "ready" },
    movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
    paths,
    progress,
    snapshot: snapshot(actor, blocker, reverseCreeps),
    tick,
  });
}

function movementResult(intent: MovementIntent): MovementRuntimeResult {
  return {
    actionDecisions: [],
    actionExecution: [],
    actionSubmitted: 0,
    movementDecisions: [{ intent, reason: "accepted", status: "accepted" }],
    movementExecution: [
      {
        intent,
        outcome: { code: 0, name: "OK", state: "scheduled" },
        reason: "accepted",
        status: "executed",
      },
    ],
    movementSubmitted: 1,
    status: "executed",
  };
}

function snapshot(actor: PositionSnapshot, blocker: boolean, reverseCreeps = false): WorldSnapshot {
  const store = {
    capacity: 50,
    freeCapacity: 0,
    resources: [{ amount: 50, resourceType: "energy" as const }],
    usedCapacity: 50,
  };
  const creeps = [
    {
      body: body(),
      fatigue: 0,
      hits: 100,
      hitsMax: 100,
      id: "worker-a",
      name: "worker",
      ownerUsername: "me",
      pos: actor,
      spawning: false,
      store,
      ticksToLive: 100,
    },
    ...(blocker
      ? [
          {
            body: body(),
            fatigue: 0,
            hits: 100,
            hitsMax: 100,
            id: "blocker-a",
            name: "blocker",
            ownerUsername: "me",
            pos: position(11, 10),
            spawning: false,
            store,
            ticksToLive: 100,
          },
        ]
      : []),
  ];
  if (reverseCreeps) creeps.reverse();
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 1,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [
          {
            id: "site-a",
            ownerUsername: "me",
            ownership: "owned",
            pos: position(15, 10),
            progress: 0,
            progressTotal: 100,
            structureType: "extension",
          },
        ],
        controller: null,
        droppedResources: [],
        energyAvailable: 0,
        energyCapacityAvailable: 0,
        hostileCreeps: [],
        name: "W1N1",
        observedAt: 10,
        ownedCreeps: creeps,
        ownedExtensions: [],
        ownedSpawns: [],
        ownedTowers: [],
        ruins: [],
        sources: [],
        storedStructures: [],
        tombstones: [],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 1,
        controllers: 0,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: creeps.length,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 0,
        tombstones: 0,
        total: creeps.length + 1,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function body() {
  const part = { active: 0, boosted: 0, total: 0 };
  return {
    activeParts: 3,
    attack: part,
    carry: { ...part, active: 1, total: 1 },
    claim: part,
    heal: part,
    move: { ...part, active: 1, total: 1 },
    rangedAttack: part,
    size: 3,
    tough: part,
    work: { ...part, active: 1, total: 1 },
  };
}
