import { describe, expect, it } from "vitest";
import type { CapabilityVector, WorkforceActor, WorkContractRecord } from "../src/contracts";
import type { LocalPathPlanningService, LocalPathPlanningRequest } from "../src/movement";
import {
  createLocalPathTravelEstimateView,
  localPathSearchAllowance,
  LOCAL_PATH_TRAVEL_SEARCH_CPU,
} from "../src/runtime/local-path-travel";
import type { WorldSnapshot } from "../src/world/snapshot";

const TICK = 100;
const SNAPSHOT = { rooms: [] } as unknown as WorldSnapshot;

describe("runtime local-path travel estimates", () => {
  it("spends the bounded cold-search allowance while still admitting cache hits", () => {
    const calls: LocalPathPlanningRequest[] = [];
    const paths: LocalPathPlanningService = {
      plan: (request) => {
        calls.push(request);
        if (request.goal.x === 13) {
          return { cost: 2, directions: [3, 3], source: "search", status: "ready" };
        }
        if (request.goal.x === 14) {
          return request.availableCpu >= LOCAL_PATH_TRAVEL_SEARCH_CPU
            ? { cost: 3, directions: [3, 3, 3], source: "search", status: "ready" }
            : { reason: "cpu-budget", status: "deferred" };
        }
        return { cost: 4, directions: [3, 3, 3, 3], source: "cache", status: "ready" };
      },
    };
    const travel = createLocalPathTravelEstimateView({
      availableCpu: LOCAL_PATH_TRAVEL_SEARCH_CPU,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });
    const worker = actor();

    expect(travel.estimate(worker, contract("contract:search", 13))).toBe(6);
    expect(travel.estimate(worker, contract("contract:deferred", 14))).toBeNull();
    expect(travel.estimate(worker, contract("contract:cache", 15))).toBe(12);
    expect(calls.map(({ availableCpu }) => availableCpu)).toEqual([
      LOCAL_PATH_TRAVEL_SEARCH_CPU,
      0,
      0,
    ]);
  });

  it("memoizes deterministic geometry across actor and contract identities", () => {
    const calls: LocalPathPlanningRequest[] = [];
    const paths: LocalPathPlanningService = {
      plan: (request) => {
        calls.push(request);
        const directions: DirectionConstant[] = Array.from(
          { length: Math.max(1, request.goal.x - request.origin.x - request.range) },
          () => 3,
        );
        return {
          cost: directions.length,
          directions,
          source: "search",
          status: "ready",
        };
      },
    };
    const travel = createLocalPathTravelEstimateView({
      availableCpu: 2,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });
    const first = contract("contract:first", 13);
    const equivalent = contract("contract:equivalent", 13);

    expect(travel.estimate(actor("actor:first"), first)).toBe(6);
    expect(travel.estimate(actor("actor:second"), equivalent)).toBe(6);
    expect(travel.estimate(actor("actor:first", 11), first)).toBe(3);
    expect(travel.estimate(actor("actor:first", 11), first)).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ origin }) => origin.x)).toEqual([10, 11]);
  });

  it("charges an attempted no-route search and memoizes its failure", () => {
    const calls: LocalPathPlanningRequest[] = [];
    const paths: LocalPathPlanningService = {
      plan: (request) => {
        calls.push(request);
        return request.availableCpu >= LOCAL_PATH_TRAVEL_SEARCH_CPU
          ? { reason: "incomplete", status: "no-path" }
          : { reason: "cpu-budget", status: "deferred" };
      },
    };
    const travel = createLocalPathTravelEstimateView({
      availableCpu: LOCAL_PATH_TRAVEL_SEARCH_CPU,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });
    const worker = actor();
    const unreachable = contract("contract:unreachable", 13);

    expect(travel.estimate(worker, unreachable)).toBeNull();
    expect(travel.estimate(worker, unreachable)).toBeNull();
    expect(travel.estimate(worker, contract("contract:next", 14))).toBeNull();
    expect(calls.map(({ availableCpu }) => availableCpu)).toEqual([
      LOCAL_PATH_TRAVEL_SEARCH_CPU,
      0,
    ]);
  });

  it("returns zero in range without a path call and rejects cross-room travel", () => {
    const calls: LocalPathPlanningRequest[] = [];
    const paths: LocalPathPlanningService = {
      plan: (request) => {
        calls.push(request);
        return { cost: 2, directions: [3], source: "search", status: "ready" };
      },
    };
    const travel = createLocalPathTravelEstimateView({
      availableCpu: 1,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });

    expect(travel.estimate(actor(), contract("contract:adjacent", 11))).toBe(0);
    expect(
      travel.estimate(actor(), contract("contract:cross-room", 11, { roomName: "W2N1" })),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("fails closed on malformed or non-finite runtime inputs", () => {
    const calls: LocalPathPlanningRequest[] = [];
    const paths: LocalPathPlanningService = {
      plan: (request) => {
        calls.push(request);
        return { cost: 2, directions: [3], source: "search", status: "ready" };
      },
    };
    const travel = createLocalPathTravelEstimateView({
      availableCpu: 1,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });

    expect(
      travel.estimate(actor("actor:nan", Number.NaN), contract("contract:valid", 13)),
    ).toBeNull();
    expect(
      travel.estimate(actor(), {
        ...contract("contract:infinite", 13),
        range: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
    const invalidBudget = createLocalPathTravelEstimateView({
      availableCpu: Number.NaN,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });
    expect(invalidBudget.estimate(actor(), contract("contract:budget", 13))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("includes current fatigue and conservative body weight in route duration", () => {
    const calls: LocalPathPlanningRequest[] = [];
    const paths: LocalPathPlanningService = {
      plan: (request) => {
        calls.push(request);
        return { cost: 2, directions: [3, 3], source: "cache", status: "ready" };
      },
    };
    const travel = createLocalPathTravelEstimateView({
      availableCpu: 0,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });

    expect(travel.estimate(actor("fatigued", 10, { fatigue: 4 }), contract("first", 13))).toBe(8);
    expect(
      travel.estimate(actor("lighter", 10, { movementWeight: 1 }), contract("equivalent", 13)),
    ).toBe(4);
    expect(calls).toHaveLength(1);
  });

  it("converts multi-step swamp cost to fatigue time before allocation", () => {
    const paths: LocalPathPlanningService = {
      plan: () => ({ cost: 10, directions: [3, 3], source: "cache", status: "ready" }),
    };
    const travel = createLocalPathTravelEstimateView({
      availableCpu: 0,
      paths,
      snapshot: SNAPSHOT,
      tick: TICK,
    });

    expect(travel.estimate(actor("swamp", 10, { fatigue: 4 }), contract("swamp", 13))).toBe(24);
  });

  it("reserves the system estimate before admitting optional searches", () => {
    expect(localPathSearchAllowance({ available: 0.5, estimate: 0.5 })).toBe(0);
    expect(localPathSearchAllowance({ available: 0.99, estimate: 0.5 })).toBeCloseTo(0.49);
    expect(localPathSearchAllowance({ available: 1, estimate: 0.5 })).toBe(0.5);
    expect(localPathSearchAllowance({ available: Number.NaN, estimate: 0.5 })).toBe(0);
  });
});

function actor(
  id = "actor:worker",
  x = 10,
  movement: { readonly fatigue?: number; readonly movementWeight?: number } = {},
): WorkforceActor {
  return {
    capability: capability({ carry: 1, move: 1, work: 1 }),
    energy: 0,
    freeCapacity: 50,
    fatigue: movement.fatigue ?? 0,
    id,
    name: id,
    movementWeight: movement.movementWeight ?? 2,
    pos: { roomName: "W1N1", x, y: 10 },
    spawning: false,
    ticksToLive: 1_000,
  };
}

function contract(
  id: string,
  x: number,
  position: { readonly roomName: string } = { roomName: "W1N1" },
): WorkContractRecord {
  return {
    budgetBinding: { category: "harvesting-filling", issuer: "test:budget" },
    conditions: { cancellation: null, failure: null, success: "work-complete" },
    deadline: 1_000,
    earliestStart: 0,
    estimatedWorkTicks: 1,
    expiresAt: 1_001,
    history: [],
    id,
    issuer: "test:travel",
    issuerKey: id,
    issuerSequence: 1,
    kind: "harvest",
    lease: null,
    leasePolicy: { duration: 10, switchingPenalty: 0, ttlSafetyMargin: 1 },
    maxAssignmentCost: 100,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: [],
    priority: { class: "survival", value: 100 },
    quantity: 1,
    range: 1,
    requestSignature: `signature:${id}`,
    requiredCapability: capability({ work: 1 }),
    revision: 1,
    state: "funded",
    target: { roomName: position.roomName, x, y: 10 },
    targetId: null,
  };
}

function capability(overrides: Partial<CapabilityVector> = {}): CapabilityVector {
  return {
    attack: 0,
    carry: 0,
    claim: 0,
    heal: 0,
    move: 0,
    rangedAttack: 0,
    tough: 0,
    work: 0,
    ...overrides,
  };
}
