import { describe, expect, it } from "vitest";
import { dispositionTransitions, planLeaseAgents } from "../src/agents";
import { CacheManager } from "../src/cache";
import { DEFAULT_SURVIVAL_POLICY } from "../src/config/defaults";
import {
  ContractLedger,
  type ContractFundingView,
  type LeasedWorkExecution,
  type TravelEstimateView,
  type WorkforceActor,
  type WorkContractRequest,
} from "../src/contracts";
import {
  getMovementProgressTracker,
  type LocalPathPlanningService,
  type MovementIntent,
  type MovementRuntimeResult,
} from "../src/movement";
import type { PositionSnapshot, WorldSnapshot } from "../src/world/snapshot";

const ROOM = "W1N1";
const ACTOR_ID = "worker-a";
const TARGET_ID = "site-a";
const TARGET = position(45, 25);

const paths: LocalPathPlanningService = {
  plan: () => ({ cost: 1, directions: [3], source: "cache", status: "ready" }),
};
const oscillationPaths: LocalPathPlanningService = {
  plan: ({ goal, origin }) => ({
    cost: 1,
    directions: [goal.x > origin.x ? 3 : 7],
    source: "cache",
    status: "ready",
  }),
};

const funding: Extract<ContractFundingView, { readonly status: "ready" }> = {
  authorizations: [
    {
      category: "growth",
      colonyId: ROOM,
      expiresAt: 200,
      issuer: "growth-budget",
      reservationId: "growth-budget:1",
      revision: 1,
      status: "active",
    },
  ],
  owners: [{ id: ROOM, visibility: "visible" }],
  status: "ready",
};

const travel: TravelEstimateView = {
  estimate: (actor, contract) =>
    actor.pos.roomName === contract.target.roomName
      ? Math.max(
          0,
          Math.max(
            Math.abs(actor.pos.x - contract.target.x),
            Math.abs(actor.pos.y - contract.target.y),
          ) - contract.range,
        )
      : null,
};

describe("leased movement continuity", () => {
  it("travels for 42 ticks across repeated 10-tick renewals without a command gap", () => {
    const ledger = fundedLedger(buildRequest());
    let actorPosition = position(2, 25);
    ledger.reconcile({
      actors: [workforceActor(actorPosition, 1)],
      funding,
      requests: [],
      tick: 1,
      transitions: [],
      travel,
    });
    const progress = getMovementProgressTracker(new CacheManager());
    const revisions = new Set<number>();

    for (let tick = 2; tick <= 43; tick += 1) {
      const snapshot = world(actorPosition, tick);
      const plan = planLeaseAgents({
        availablePathCpu: 1,
        execution: ledger.executionView(),
        movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
        paths,
        progress,
        snapshot,
        tick,
      });
      expect(plan.actions, `unexpected action at tick ${String(tick)}`).toEqual([]);
      expect(plan.dispositions, `unexpected disposition at tick ${String(tick)}`).toEqual([]);
      expect(plan.movement, `missing movement at tick ${String(tick)}`).toHaveLength(1);
      const intent = plan.movement[0] as MovementIntent;
      expect(intent.deadline).toBeGreaterThanOrEqual(tick);
      revisions.add(intent.contractRevision ?? -1);
      progress.record(movementResult(intent), snapshot, tick);

      ledger.reconcile({
        actors: [workforceActor(actorPosition, tick)],
        funding,
        requests: [],
        tick,
        transitions: [],
        travel,
      });
      expect(ledger.view().active[0]?.lease?.expiresAt).toBeGreaterThan(tick);
      actorPosition = position(actorPosition.x + 1, actorPosition.y);
    }

    const actionTick = 44;
    const actionPlan = planLeaseAgents({
      availablePathCpu: 1,
      execution: ledger.executionView(),
      movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
      paths,
      progress,
      snapshot: world(actorPosition, actionTick),
      tick: actionTick,
    });
    expect(actorPosition).toEqual(position(44, 25));
    expect(actionPlan.dispositions).toEqual([]);
    expect(actionPlan.movement).toEqual([]);
    expect(actionPlan.actions).toEqual([
      expect.objectContaining({
        actorId: ACTOR_ID,
        contractId: ledger.view().active[0]?.id,
        kind: "build",
      }),
    ]);
    expect(revisions.size).toBeGreaterThanOrEqual(5);
  });

  it("reaches blockedReleaseTicks through a lease renewal and suspends exact work", () => {
    const ledger = fundedLedger(buildRequest({ target: position(15, 25) }));
    const actorPosition = position(2, 25);
    ledger.reconcile({
      actors: [workforceActor(actorPosition, 1)],
      funding,
      requests: [],
      tick: 1,
      transitions: [],
      travel,
    });
    const progress = getMovementProgressTracker(new CacheManager());
    let renewedRevision: number | null = null;

    for (let tick = 2; tick <= 11; tick += 1) {
      const snapshot = world(actorPosition, tick, position(15, 25));
      const plan = planLeaseAgents({
        availablePathCpu: 1,
        execution: ledger.executionView(),
        movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
        paths,
        progress,
        snapshot,
        tick,
      });
      expect(plan.dispositions).toEqual([]);
      expect(plan.movement).toHaveLength(1);
      const intent = plan.movement[0] as MovementIntent;
      progress.record(movementResult(intent), snapshot, tick);
      const beforeRevision = ledger.executionView().leases[0]?.revision ?? null;
      ledger.reconcile({
        actors: [workforceActor(actorPosition, tick)],
        funding,
        requests: [],
        tick,
        transitions: [],
        travel,
      });
      const afterRevision = ledger.executionView().leases[0]?.revision ?? null;
      if (beforeRevision !== afterRevision) renewedRevision = afterRevision;
    }

    expect(renewedRevision).not.toBeNull();
    const blocked = planLeaseAgents({
      availablePathCpu: 1,
      execution: ledger.executionView(),
      movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
      paths,
      progress,
      snapshot: world(actorPosition, 12, position(15, 25)),
      tick: 12,
    });
    expect(blocked.actions).toEqual([]);
    expect(blocked.movement).toEqual([]);
    expect(blocked.dispositions).toEqual([
      expect.objectContaining({
        contractRevision: renewedRevision,
        reason: "movement-blocked",
        to: "suspended",
      }),
    ]);

    const reconciled = ledger.reconcile({
      actors: [workforceActor(actorPosition, 12)],
      funding,
      requests: [],
      tick: 12,
      transitions: dispositionTransitions(blocked.dispositions, 12),
      travel,
    });
    expect(reconciled.transitions).toEqual([
      expect.objectContaining({ accepted: true, to: "suspended" }),
    ]);
    expect(ledger.executionView().leases).toEqual([]);
  });

  it("bounds repeated controller-source A-B goal switching as oscillation evidence", () => {
    const progress = getMovementProgressTracker(new CacheManager());
    const actorPosition = position(25, 25);
    const controllerLease = oscillationLease("upgrade");
    const sourceLease = oscillationLease("harvest");

    for (let tick = 20; tick <= 30; tick += 1) {
      const lease = tick % 2 === 0 ? controllerLease : sourceLease;
      const snapshot = oscillationWorld(actorPosition, tick);
      const plan = planLeaseAgents({
        availablePathCpu: 1,
        execution: { leases: [lease], status: "ready" },
        movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
        paths: oscillationPaths,
        progress,
        snapshot,
        tick,
      });
      expect(plan.dispositions).toEqual([]);
      expect(plan.movement).toHaveLength(1);
      progress.record(movementResult(plan.movement[0] as MovementIntent), snapshot, tick);
    }

    const blocked = planLeaseAgents({
      availablePathCpu: 1,
      execution: { leases: [sourceLease], status: "ready" },
      movementPolicy: DEFAULT_SURVIVAL_POLICY.movement,
      paths: oscillationPaths,
      progress,
      snapshot: oscillationWorld(actorPosition, 31),
      tick: 31,
    });
    expect(blocked.movement).toEqual([]);
    expect(blocked.dispositions).toEqual([
      expect.objectContaining({ reason: "movement-oscillation", to: "suspended" }),
    ]);
  });
});

function fundedLedger(request: WorkContractRequest): ContractLedger {
  const opened = ContractLedger.open({});
  if (opened.status !== "ready") throw new Error("contract ledger did not open");
  const submitted = opened.ledger.submit(request, 0);
  if (!submitted.accepted) throw new Error(`contract submission failed: ${submitted.reason}`);
  const transition = opened.ledger.reconcile({
    actors: [],
    funding,
    requests: [],
    tick: 0,
    transitions: [
      {
        contractId: submitted.contractId,
        reason: "fixture-funded",
        tick: 0,
        to: "funded",
      },
    ],
    travel,
  }).transitions[0];
  if (transition?.accepted !== true) throw new Error("contract funding failed");
  return opened.ledger;
}

function buildRequest(
  overrides: Partial<Pick<WorkContractRequest, "target">> = {},
): WorkContractRequest {
  const target = overrides.target ?? TARGET;
  return {
    budgetBinding: { category: "growth", issuer: "growth-budget" },
    conditions: { cancellation: null, failure: "failed", success: "built" },
    deadline: 100,
    earliestStart: 0,
    estimatedWorkTicks: 1,
    execution: {
      action: "build",
      completion: "work-complete",
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    expiresAt: 101,
    issuer: "growth/runtime-continuity",
    issuerKey: `build/${String(target.x)}/${String(target.y)}`,
    issuerSequence: 1,
    kind: "build",
    leasePolicy: { duration: 10, switchingPenalty: 2, ttlSafetyMargin: 1 },
    maxAssignmentCost: 1_500,
    owner: { id: ROOM, kind: "colony" },
    preconditionKeys: ["target-visible"],
    priority: { class: "growth", value: 100 },
    quantity: 5,
    range: 1,
    requiredCapability: capability(),
    target,
    targetId: TARGET_ID,
  };
}

function workforceActor(pos: PositionSnapshot, tick: number): WorkforceActor {
  return {
    capability: capability(),
    energy: 50,
    freeCapacity: 0,
    id: ACTOR_ID,
    name: "worker",
    pos,
    spawning: false,
    ticksToLive: 200 - tick,
  };
}

function world(
  pos: PositionSnapshot,
  tick: number,
  target: PositionSnapshot = TARGET,
): WorldSnapshot {
  const store = {
    capacity: 50,
    freeCapacity: 0,
    resources: [{ amount: 50, resourceType: "energy" as const }],
    usedCapacity: 50,
  };
  const creep = {
    body: {
      activeParts: 3,
      attack: bodyPart(),
      carry: bodyPart(1),
      claim: bodyPart(),
      heal: bodyPart(),
      move: bodyPart(1),
      rangedAttack: bodyPart(),
      size: 3,
      tough: bodyPart(),
      work: bodyPart(1),
    },
    fatigue: 0,
    hits: 100,
    hitsMax: 100,
    id: ACTOR_ID,
    name: "worker",
    ownerUsername: "me",
    pos,
    spawning: false,
    store,
    ticksToLive: 200 - tick,
  };
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 1,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [
          {
            id: TARGET_ID,
            ownerUsername: "me",
            ownership: "owned",
            pos: target,
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
        name: ROOM,
        observedAt: tick,
        ownedCreeps: [creep],
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
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 0,
        tombstones: 0,
        total: 2,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function oscillationLease(kind: "harvest" | "upgrade"): LeasedWorkExecution {
  const upgrade = kind === "upgrade";
  return {
    actorId: ACTOR_ID,
    actorName: "worker",
    contractId: upgrade ? "upgrade-controller" : "harvest-source",
    deadline: 100,
    execution: {
      action: upgrade ? "upgrade-controller" : "harvest",
      completion: "continuous",
      counterpartId: null,
      resourceType: upgrade ? "energy" : null,
      version: 1,
    },
    expiresAt: 101,
    leaseExpiresAt: 100,
    priority: { class: upgrade ? "growth" : "survival", value: 100 },
    quantity: 1,
    range: upgrade ? 3 : 1,
    revision: 2,
    state: "assigned",
    target: upgrade ? position(45, 25) : position(5, 25),
    targetId: upgrade ? "controller-a" : "source-a",
  };
}

function oscillationWorld(pos: PositionSnapshot, tick: number): WorldSnapshot {
  const snapshot = world(pos, tick);
  const room = snapshot.rooms[0];
  const creep = room?.ownedCreeps[0];
  if (room === undefined || creep === undefined)
    throw new Error("missing oscillation fixture room");
  const energy = 25;
  return {
    ...snapshot,
    rooms: [
      {
        ...room,
        constructionSites: [],
        controller: {
          id: "controller-a",
          level: 1,
          ownerUsername: "me",
          ownership: "owned",
          pos: position(45, 25),
          progress: 0,
          progressTotal: 200,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: 20_000,
          upgradeBlocked: null,
        },
        ownedCreeps: [
          {
            ...creep,
            store: {
              capacity: 50,
              freeCapacity: 50 - energy,
              resources: [{ amount: energy, resourceType: "energy" }],
              usedCapacity: energy,
            },
          },
        ],
        sources: [
          {
            energy: 3_000,
            energyCapacity: 3_000,
            id: "source-a",
            pos: position(5, 25),
            ticksToRegeneration: null,
          },
        ],
      },
    ],
  };
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

function position(x: number, y: number): PositionSnapshot {
  return { roomName: ROOM, x, y };
}

function capability() {
  return {
    attack: 0,
    carry: 1,
    claim: 0,
    heal: 0,
    move: 1,
    rangedAttack: 0,
    tough: 0,
    work: 1,
  };
}

function bodyPart(active = 0) {
  return { active, boosted: 0, total: active };
}
