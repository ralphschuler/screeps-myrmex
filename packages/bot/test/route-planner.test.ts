import { describe, expect, it } from "vitest";
import { CacheManager } from "../src/cache";
import {
  DEFAULT_ROUTE_POLICY_V1,
  RoutePlanner,
  getRoutePlanCache,
  observeRouteTopology,
  projectRouteRoomEvidence,
  type RoutePlanRequest,
  type RouteRoomEvidence,
} from "../src/world/routes";
import type { RoomIntelQueryResult } from "../src/world/intel";

describe("RoutePlanner", () => {
  it("observes bounded canonical Game.map exits and room status through the world boundary", () => {
    const topology = observeRouteTopology({
      roomNames: ["W2N1", "W1N1"],
      map: {
        describeExits(roomName) {
          return roomName === "W1N1" ? { 3: "W2N1", 1: "W1N2" } : {};
        },
        getRoomStatus(roomName) {
          return {
            status: roomName === "W2N1" ? "closed" : "normal",
            timestamp: roomName === "W2N1" ? 123_000 : null,
          };
        },
      },
    });

    expect(topology).toEqual({
      status: "ready",
      rooms: [
        { roomName: "W1N1", exits: ["W1N2", "W2N1"], status: "normal", timestamp: null },
        { roomName: "W2N1", exits: [], status: "closed", timestamp: 123_000 },
      ],
    });
  });

  it("projects freshness-qualified terrain and diplomacy/threat evidence without live objects", () => {
    const evidence = projectRouteRoomEvidence({
      roomName: "W1N1",
      exits: ["W2N1", "W0N1"],
      status: "normal",
      relation: "ally",
      threatRisk: 0,
      intel: intelResult("2" + "0".repeat(2_499)),
    });

    expect(evidence).toEqual({
      roomName: "W1N1",
      exits: ["W0N1", "W2N1"],
      status: "normal",
      relation: "ally",
      freshness: "fresh",
      quality: "complete",
      threatRisk: 0,
      terrain: { road: 1, plain: 2_499, swamp: 0 },
    });
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("caps valid route requests per tick before repeated cache or search work", () => {
    const routes = planner();
    const request = routeRequest(graph([room("W1N1", ["W1N2"]), room("W1N2", [])]));

    const admitted = Array.from({ length: 8 }, (_, index) =>
      routes.plan({ ...request, id: `route/${String(index)}` }),
    );
    const denied = routes.plan({ ...request, id: "route/over-cap" });

    expect(admitted.every(({ status }) => status === "ready")).toBe(true);
    expect(denied).toMatchObject({ status: "deferred", reason: "request-budget" });
  });

  it("invalidates cached plans on threat revision and fails closed with a typed unsafe result", () => {
    const cacheManager = new CacheManager();
    const routes = new RoutePlanner(getRoutePlanCache(cacheManager));
    const safeRooms = graph([room("W1N1", ["W1N2"]), room("W1N2", [])]);
    const request = routeRequest(safeRooms);

    expect(routes.plan(request)).toMatchObject({
      status: "ready",
      reason: "route-computed",
      source: "search",
    });
    expect(routes.plan({ ...request, tick: 101 })).toMatchObject({
      status: "ready",
      reason: "route-cache-hit",
      source: "cache",
      metrics: { cacheHits: 1 },
    });

    const threatened = routes.plan({
      ...request,
      tick: 102,
      threatRevision: "threat-v2",
      rooms: graph([room("W1N1", ["W1N2"]), room("W1N2", [], { threatRisk: 1 })]),
    });
    expect(threatened).toMatchObject({
      status: "unsafe-route",
      reason: "unsafe-risk",
      source: "search",
      plan: null,
      metrics: { risk: 1 },
    });
  });

  it("returns stale, closed, protected, CPU, cost, and timeout outcomes without reservations", () => {
    const base = routeRequest(
      graph([room("W1N1", ["W1N2"]), room("W1N2", [], { freshness: "stale" })]),
    );
    expect(planner().plan(base)).toMatchObject({ status: "stale-route", reason: "stale-intel" });
    expect(
      planner().plan({
        ...base,
        intelRevision: "intel-current",
        rooms: graph([room("W1N1", ["W1N2"]), room("W1N2", [], { status: "closed" })]),
      }),
    ).toMatchObject({ status: "no-route", reason: "no-path" });
    expect(
      planner().plan({
        ...base,
        intelRevision: "intel-current",
        rooms: graph([
          room("W1N1", ["W1N2"]),
          room("W1N2", [], { status: "novice", freshness: "current" }),
        ]),
      }),
    ).toMatchObject({ status: "no-route", reason: "no-path" });
    expect(
      planner().plan({
        ...base,
        availableCpuMilli: 0,
        intelRevision: "intel-current",
        rooms: graph([room("W1N1", ["W1N2"]), room("W1N2", [])]),
      }),
    ).toMatchObject({ status: "deferred", reason: "cpu-budget" });
    expect(
      planner().plan({
        ...base,
        intelRevision: "intel-current",
        budget: { ...base.budget, maximumTotalCost: 1 },
        rooms: graph([room("W1N1", ["W1N2"]), room("W1N2", [])]),
      }),
    ).toMatchObject({ status: "deferred", reason: "cost-budget" });
    expect(planner().plan({ ...base, tick: 111 })).toMatchObject({
      status: "deferred",
      reason: "timeout",
    });
    expect(planner().plan({ ...base, deadline: base.tick + 50_001 })).toMatchObject({
      status: "invalid",
      reason: "invalid-input",
    });
  });

  it("prefers an equal-hop highway route without treating an allied alternative as hostile", () => {
    const request = routeRequest(
      graph([
        room("W1N1", ["W0N1", "W2N1"]),
        room("W0N1", ["W1N2"]),
        room("W2N1", ["W1N2"], { relation: "ally" }),
        room("W1N2", []),
      ]),
    );

    expect(planner().plan(request)).toMatchObject({
      status: "ready",
      plan: { roomNames: ["W0N1", "W1N2"], risk: 0 },
    });
  });

  it("defers at search and encoded-result ceilings before returning a partial plan", () => {
    const request = routeRequest(
      graph([room("W1N1", ["W1N2"]), room("W1N2", ["W1N3"]), room("W1N3", [])]),
    );
    const destinationRequest = {
      ...request,
      destinationRoomName: "W1N3",
      budget: { ...request.budget, maximumExpandedRooms: 1 },
    };

    expect(planner().plan(destinationRequest)).toMatchObject({
      status: "deferred",
      reason: "search-budget",
      plan: null,
    });
    expect(
      planner().plan({
        ...request,
        budget: { ...request.budget, maximumPlanCodeUnits: 1 },
      }),
    ).toMatchObject({ status: "deferred", reason: "memory-budget", plan: null });
  });

  it("estimates fatigue-safe body throughput and road exposure from entered-room terrain", () => {
    const request = routeRequest(
      graph([room("W1N1", ["W1N2"]), room("W1N2", [], { terrain: terrain(0, 50, 0) })]),
    );

    expect(planner().plan(request)).toMatchObject({
      status: "ready",
      plan: {
        estimate: {
          outboundTicks: 100,
          returnTicks: 50,
          roundTripTicks: 150,
          throughputMilliCapacityPerTick: 333,
          roadSteps: 0,
          plainSteps: 50,
          swampSteps: 0,
          roadBodyPartSteps: 0,
        },
      },
    });
  });

  it("selects one deterministic fresh safe route across input reorder and heap reset", () => {
    const rooms = graph([
      room("W1N1", ["W0N1", "W2N1"]),
      room("W0N1", ["W0N2"], { terrain: terrain(0, 0, 50) }),
      room("W0N2", ["W1N2"], { relation: "ally", terrain: terrain(50, 0, 0) }),
      room("W2N1", ["W2N2"], { threatRisk: 20 }),
      room("W2N2", ["W1N2"]),
      room("W1N2", []),
    ]);
    const request = routeRequest(rooms);

    const ordered = planner().plan(request);
    const reordered = planner().plan({ ...request, rooms: [...rooms].reverse() });

    expect(reordered).toEqual(ordered);
    expect(ordered).toMatchObject({
      status: "ready",
      reason: "route-computed",
      source: "search",
      plan: {
        roomNames: ["W0N1", "W0N2", "W1N2"],
        risk: 0,
        estimate: {
          roadSteps: 50,
          swampSteps: 50,
        },
      },
    });
  });
});

function intelResult(cells: string): RoomIntelQueryResult {
  return {
    roomName: "W1N1",
    freshness: "fresh",
    quality: "complete",
    reason: "segment-ready",
    generation: 1,
    record: {
      schemaVersion: 1,
      shard: "shard0",
      roomName: "W1N1",
      observedAt: 95,
      eventsObservedAt: 94,
      complete: true,
      terrain: { cells, revision: "terrain-v1" },
      controller: null,
      mineral: null,
      mineralStatus: "complete",
      sources: [],
      sourceStatus: "complete",
      structures: [
        {
          hits: 5_000,
          hitsMax: 5_000,
          id: "road-a",
          invaderCore: null,
          isPublic: null,
          ownerUsername: null,
          ownership: "unowned",
          portal: null,
          pos: { x: 0, y: 0 },
          structureType: "road",
          ticksToDecay: null,
        },
      ],
      structureStatus: "complete",
      hostiles: [],
      hostileStatus: "complete",
      events: [],
      eventLogStatus: "observed",
    },
  };
}

function planner(): RoutePlanner {
  return new RoutePlanner(getRoutePlanCache(new CacheManager()));
}

function routeRequest(rooms: readonly RouteRoomEvidence[]): RoutePlanRequest {
  return {
    id: "route/owned-to-remote",
    originRoomName: "W1N1",
    destinationRoomName: "W1N2",
    tick: 100,
    deadline: 110,
    availableCpuMilli: 500,
    topologyRevision: "topology-v1",
    intelRevision: "intel-v1",
    diplomacyRevision: "diplomacy-v1",
    threatRevision: "threat-v1",
    policy: DEFAULT_ROUTE_POLICY_V1,
    body: {
      moveParts: 1,
      carryParts: 1,
      nonMoveNonCarryParts: 1,
      outboundLoadedCarryParts: 1,
      returnLoadedCarryParts: 0,
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

function graph(rooms: readonly RouteRoomEvidence[]): readonly RouteRoomEvidence[] {
  return rooms;
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

function terrain(
  road: number,
  plain: number,
  swamp: number,
): NonNullable<RouteRoomEvidence["terrain"]> {
  return { road, plain, swamp };
}
