import { describe, expect, it } from "vitest";
import { CacheManager } from "../src/cache";
import { DEFAULT_SURVIVAL_POLICY } from "../src/config/defaults";
import { getMovementPathCache, LocalPathPlanner } from "../src/movement";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

describe("movement path cache", () => {
  it("registers bounded static-only namespaces once and reconstructs values after a heap reset", () => {
    const firstManager = new CacheManager();
    const first = getMovementPathCache(firstManager);
    expect(getMovementPathCache(firstManager)).toBe(first);
    expect(firstManager.registeredNamespaceIds()).toEqual([
      "movement.local-path.v1",
      "movement.static-matrix.v1",
    ]);

    first.staticMatrices.set(
      ["W1N1", "terrain:1"],
      {
        roomName: "W1N1",
        revision: "terrain:1",
        walkable: [0, 1, 2],
      },
      { tick: 1 },
    );
    first.localPaths.set(
      ["W1N1", "origin:goal"],
      {
        directions: [3, 3],
        roomName: "W1N1",
      },
      { tick: 1 },
    );
    expect(first.staticMatrices.get(["W1N1", "terrain:1"], { tick: 2 })).toMatchObject({
      hit: true,
    });
    expect(first.localPaths.get(["W1N1", "origin:goal"], { tick: 2 })).toMatchObject({ hit: true });

    const reset = getMovementPathCache(new CacheManager());
    expect(reset.staticMatrices.get(["W1N1", "terrain:1"], { tick: 2 })).toEqual({ hit: false });
    expect(reset.localPaths.get(["W1N1", "origin:goal"], { tick: 2 })).toEqual({ hit: false });
  });

  it("uses only configured local bounds, defers a cold search without CPU, and reuses an equivalent path", () => {
    const cache = getMovementPathCache(new CacheManager());
    const calls: unknown[] = [];
    let matrixBuilds = 0;
    const planner = new LocalPathPlanner(
      cache,
      {
        search: (input) => {
          calls.push(input);
          return { cost: 2, directions: [3, 3], incomplete: false };
        },
      },
      DEFAULT_SURVIVAL_POLICY.movement,
    );
    const request = {
      availableCpu: 1,
      buildStaticMatrix: () => {
        matrixBuilds += 1;
        return { roomName: "W1N1", revision: "terrain:1", walkable: [0, 1, 2] };
      },
      estimatedSearchCpu: 2,
      goal: position(12, 10),
      origin: position(10, 10),
      range: 1,
      staticMatrixRevision: "terrain:1",
      tick: 1,
    };

    expect(planner.plan(request)).toEqual({ reason: "cpu-budget", status: "deferred" });
    expect(calls).toHaveLength(0);
    expect(matrixBuilds).toBe(0);

    const searched = planner.plan({ ...request, availableCpu: 2 });
    expect(searched).toMatchObject({ source: "search", status: "ready" });
    expect(matrixBuilds).toBe(1);
    expect(calls).toEqual([
      expect.objectContaining({
        maxCost: DEFAULT_SURVIVAL_POLICY.movement.maximumPathCost,
        maxOps: DEFAULT_SURVIVAL_POLICY.movement.maximumSearchOperations,
        origin: position(10, 10),
      }),
    ]);
    expect(planner.plan({ ...request, tick: 2 })).toMatchObject({
      source: "cache",
      status: "ready",
    });
    expect(calls).toHaveLength(1);

    const coldPlanner = new LocalPathPlanner(
      getMovementPathCache(new CacheManager()),
      { search: () => ({ cost: 2, directions: [3, 3], incomplete: false }) },
      DEFAULT_SURVIVAL_POLICY.movement,
    );
    expect(coldPlanner.plan({ ...request, availableCpu: 2, tick: 2 })).toEqual(searched);
  });

  it("rejects cross-room, incomplete, and over-cost results without caching them", () => {
    let calls = 0;
    const planner = new LocalPathPlanner(
      getMovementPathCache(new CacheManager()),
      {
        search: () => {
          calls += 1;
          return {
            cost: DEFAULT_SURVIVAL_POLICY.movement.maximumPathCost + 1,
            directions: [3],
            incomplete: false,
          };
        },
      },
      DEFAULT_SURVIVAL_POLICY.movement,
    );
    const request = {
      availableCpu: 2,
      buildStaticMatrix: () => ({ roomName: "W1N1", revision: "terrain:1", walkable: [] }),
      estimatedSearchCpu: 1,
      goal: position(12, 10),
      origin: position(10, 10),
      range: 1,
      staticMatrixRevision: "terrain:1",
      tick: 1,
    };

    expect(planner.plan({ ...request, goal: { ...position(12, 10), roomName: "W2N1" } })).toEqual({
      reason: "invalid",
      status: "no-path",
    });
    expect(planner.plan(request)).toEqual({ reason: "incomplete", status: "no-path" });
    expect(planner.plan({ ...request, tick: 2 })).toEqual({
      reason: "incomplete",
      status: "no-path",
    });
    expect(calls).toBe(2);
  });
});
