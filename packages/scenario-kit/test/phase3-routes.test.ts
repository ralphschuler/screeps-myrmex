import { describe, expect, it } from "vitest";
import { CacheManager } from "../../bot/src/cache";
import {
  DEFAULT_ROUTE_POLICY_V1,
  RoutePlanner,
  getRoutePlanCache,
  type RoutePlanRequest,
  type RoutePlanStatus,
  type RouteRoomEvidence,
} from "../../bot/src/world/routes";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

interface RouteWorld {
  readonly completedTicks: number;
}

interface RouteInput {
  readonly kind: "safe" | "unsafe" | "stale" | "closed" | "novice" | "pressure";
  readonly pressureBatch: number;
  readonly reverse: boolean;
}

interface RouteOutcome {
  readonly status: RoutePlanStatus;
  readonly roomNames: readonly string[];
  readonly risk: number;
  readonly roundTripTicks: number;
  readonly evictions: number;
}

interface RouteHeap {
  readonly cache: ReturnType<typeof getRoutePlanCache>;
  readonly planner: RoutePlanner;
}

describe("Phase 3 threat-aware route deterministic outcome", () => {
  it("keeps safe route decisions stable across evidence reorder, invalidation, eviction, and reset", () => {
    const warm = runScenario(routeScenario(false, false));
    const resetReordered = runScenario(routeScenario(true, true));

    expect(resetReordered.outcomes).toEqual(warm.outcomes);
    expect(resetReordered.finalWorld).toEqual(warm.finalWorld);
    expect(resetReordered.outcomeHash).toBe(warm.outcomeHash);
    expect(resetReordered.transcriptHash).not.toBe(warm.transcriptHash);
    expect(warm.outcomes.slice(0, 5)).toEqual([
      expect.objectContaining({
        status: "ready",
        roomNames: ["W0N1", "W0N2", "W1N2"],
        risk: 0,
      }),
      expect.objectContaining({ status: "unsafe-route", risk: 20 }),
      expect.objectContaining({ status: "stale-route" }),
      expect.objectContaining({ status: "no-route" }),
      expect.objectContaining({ status: "no-route" }),
    ]);
    expect(warm.outcomes.slice(5).every(({ status }) => status === "ready")).toBe(true);
    expect(warm.outcomes[warm.outcomes.length - 1]).toMatchObject({ evictions: 8 });
  });
});

function routeScenario(
  reset: boolean,
  reverse: boolean,
): ReplayScenario<RouteWorld, RouteInput, RouteOutcome, RouteHeap> {
  const inputs: readonly RouteInput[] = [
    ...(["safe", "unsafe", "stale", "closed", "novice"] as const).map((kind) => ({
      kind,
      pressureBatch: 0,
      reverse,
    })),
    ...Array.from({ length: 9 }, (_, pressureBatch) => ({
      kind: "pressure" as const,
      pressureBatch,
      reverse,
    })),
  ];
  const createHeap = (): RouteHeap => {
    const cache = getRoutePlanCache(new CacheManager());
    return { cache, planner: new RoutePlanner(cache) };
  };
  return defineReplayScenario({
    id: "phase3/routes/threat-aware-costs",
    seed: "phase3-routes-v1",
    initialWorld: { completedTicks: 0 },
    ticks: inputs.map((input, index) => ({
      gameTime: 2_000 + index,
      cpuBudget: input.kind === "pressure" ? 2 : 0.25,
      resetHeap: reset && [1, 3].includes(index),
      input,
    })),
    createHeap,
    resetHeap: createHeap,
    step({ gameTime, heap, input }) {
      let result;
      let evictions = 0;
      if (input.kind === "pressure") {
        if (input.pressureBatch === 0) heap.cache.plans.clear();
        const before = heap.cache.plans.metrics().evictions;
        for (let batchIndex = 0; batchIndex < 8; batchIndex += 1) {
          const index = input.pressureBatch * 8 + batchIndex;
          const destination = `W${String(index + 2)}N9`;
          result = heap.planner.plan(
            request(gameTime, `pressure-${String(index)}`, [
              room("W1N9", [destination]),
              room(destination, []),
            ]),
          );
        }
        evictions = heap.cache.plans.metrics().evictions - before;
      } else {
        result = heap.planner.plan(
          request(gameTime, input.kind, evidence(input.kind, input.reverse)),
        );
      }
      if (result === undefined) throw new Error("route pressure produced no result");
      return {
        nextWorld: { completedTicks: gameTime - 1_999 },
        outcome: {
          status: result.status,
          roomNames: result.plan?.roomNames ?? [],
          risk: result.plan?.risk ?? result.metrics.risk,
          roundTripTicks: result.plan?.estimate.roundTripTicks ?? 0,
          evictions,
        },
        cpuUsed: input.kind === "pressure" ? 2 : 0.25,
      };
    },
    verify({ outcomes }) {
      if (outcomes.length !== inputs.length) throw new Error("route outcome count mismatch");
      if (outcomes[outcomes.length - 1]?.evictions !== 8) {
        throw new Error("route cache did not evict at its bound");
      }
    },
  });
}

function evidence(
  kind: Exclude<RouteInput["kind"], "pressure">,
  reverse: boolean,
): readonly RouteRoomEvidence[] {
  const rooms =
    kind === "safe"
      ? [
          room("W1N1", ["W0N1", "W2N1"]),
          room("W0N1", ["W0N2"], { terrain: terrain(0, 0, 50) }),
          room("W0N2", ["W1N2"], { relation: "ally", terrain: terrain(50, 0, 0) }),
          room("W2N1", ["W2N2"], { threatRisk: 20 }),
          room("W2N2", ["W1N2"]),
          room("W1N2", []),
        ]
      : [
          room("W1N1", ["W1N2"]),
          room("W1N2", [], {
            ...(kind === "unsafe" ? { threatRisk: 20 } : {}),
            ...(kind === "stale" ? { freshness: "stale" as const } : {}),
            ...(kind === "closed" ? { status: "closed" as const } : {}),
            ...(kind === "novice" ? { status: "novice" as const } : {}),
          }),
        ];
  return reverse ? [...rooms].reverse() : rooms;
}

function request(tick: number, id: string, rooms: readonly RouteRoomEvidence[]): RoutePlanRequest {
  return {
    id: `route/${id}`,
    originRoomName: rooms.some(({ roomName }) => roomName === "W1N9") ? "W1N9" : "W1N1",
    destinationRoomName: id.startsWith("pressure-")
      ? (rooms.find(({ roomName }) => roomName !== "W1N9")?.roomName ?? "W2N9")
      : "W1N2",
    tick,
    deadline: tick + 10,
    availableCpuMilli: 250,
    topologyRevision: `topology/${id}`,
    intelRevision: `intel/${id}`,
    diplomacyRevision: "diplomacy-v1",
    threatRevision: `threat/${id}`,
    policy: DEFAULT_ROUTE_POLICY_V1,
    body: {
      moveParts: 1,
      carryParts: 1,
      nonMoveNonCarryParts: 1,
      outboundLoadedCarryParts: 0,
      returnLoadedCarryParts: 1,
      initialFatigue: 0,
    },
    budget: {
      maximumExpandedRooms: 32,
      maximumRouteRooms: 8,
      maximumTotalCost: 20_000,
      maximumRisk: 0,
      maximumPlanCodeUnits: 4_096,
    },
    rooms,
  };
}

function room(
  roomName: string,
  exits: readonly string[],
  overrides: Partial<RouteRoomEvidence> = {},
): RouteRoomEvidence {
  return {
    roomName,
    exits,
    status: "normal",
    relation: "neutral",
    freshness: "current",
    quality: "complete",
    threatRisk: 0,
    terrain: terrain(0, 50, 0),
    ...overrides,
  };
}

function terrain(road: number, plain: number, swamp: number) {
  return { road, plain, swamp };
}
