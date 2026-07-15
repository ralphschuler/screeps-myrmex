import { describe, expect, it } from "vitest";
import {
  CacheManager,
  createJsonCacheCodec,
  deterministicCacheKey,
  type CacheNamespace,
  type JsonValue,
} from "../src/cache";

type Plan = {
  readonly room: string;
  readonly steps: readonly string[];
};

describe("deterministic cache keys", () => {
  it("canonicalizes record fields without collapsing distinct scalar types", () => {
    expect(deterministicCacheKey({ room: "W1N1", position: { y: 17, x: 8 } })).toBe(
      deterministicCacheKey({ position: { x: 8, y: 17 }, room: "W1N1" }),
    );
    expect(deterministicCacheKey(1)).not.toBe(deterministicCacheKey("1"));
    expect(deterministicCacheKey(["a", "b"])).not.toBe(deterministicCacheKey({ 0: "a", 1: "b" }));
  });

  it("rejects values that cannot be replayed as deterministic data", () => {
    expect(() => deterministicCacheKey(Number.NaN)).toThrow(/non-finite/);
    expect(() => deterministicCacheKey(undefined as never)).toThrow(/unsupported/);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => deterministicCacheKey(cyclic as never)).toThrow(/cycles/);

    const sparse: string[] = [];
    sparse.length = 1;
    expect(() => deterministicCacheKey(sparse)).toThrow(/dense/);
  });
});

describe("CacheManager", () => {
  it("registers typed namespaces once and exposes them in stable order", () => {
    const manager = new CacheManager();
    createNamespace(manager, "zeta");
    createNamespace(manager, "alpha");

    expect(manager.registeredNamespaceIds()).toEqual(["alpha", "zeta"]);
    expect(() => createNamespace(manager, "alpha")).toThrow(/already registered/);
  });

  it("expires entries at an exclusive TTL boundary", () => {
    const manager = new CacheManager();
    const cache = createNamespace(manager, "paths", { ttlTicks: 2 });

    cache.set(
      "W1N1",
      { room: "W1N1", steps: ["left"] },
      { tick: 10, dependencies: { terrain: 4 } },
    );

    expect(cache.get("W1N1", { tick: 11, dependencies: { terrain: 4 } })).toEqual({
      hit: true,
      value: { room: "W1N1", steps: ["left"] },
    });
    expect(cache.get("W1N1", { tick: 12, dependencies: { terrain: 4 } })).toEqual({ hit: false });
    expect(cache.metrics()).toMatchObject({
      entries: 0,
      reads: 2,
      hits: 1,
      misses: 1,
      expirations: 1,
    });
  });

  it("supports an explicit non-expiring override", () => {
    const manager = new CacheManager();
    const cache = createNamespace(manager, "static-terrain", { ttlTicks: 1 });

    cache.set("W2N2", { room: "W2N2", steps: [] }, { tick: 5, ttlTicks: null });

    expect(cache.get("W2N2", { tick: 50_000 })).toMatchObject({ hit: true });
  });

  it("sweeps expiry with a hard per-call inspection budget", () => {
    const manager = new CacheManager();
    const cache = createNamespace(manager, "sweep", { ttlTicks: 1 });
    for (const key of ["a", "b", "c", "d", "e"]) {
      cache.set(key, { room: key, steps: [] }, { tick: 1 });
    }

    expect(manager.sweep(2, 2)).toEqual({ inspected: 2, removed: 2, complete: false });
    expect(cache.metrics()).toMatchObject({ entries: 3, expirations: 2 });
    expect(manager.sweep(2, 2)).toEqual({ inspected: 2, removed: 2, complete: false });
    expect(manager.sweep(2, 2)).toEqual({ inspected: 1, removed: 1, complete: true });
    expect(cache.metrics()).toMatchObject({ entries: 0, expirations: 5, encodedLength: 0 });
  });

  it("matches complete dependency stamps independent of field order", () => {
    const manager = new CacheManager();
    const cache = createNamespace(manager, "room-plans");

    cache.set(
      "W3N3",
      { room: "W3N3", steps: ["build"] },
      { tick: 20, dependencies: { structures: 8, terrain: 2 } },
    );

    expect(
      cache.get("W3N3", {
        tick: 21,
        dependencies: { terrain: 2, structures: 8 },
      }),
    ).toMatchObject({ hit: true });
    expect(
      cache.get("W3N3", {
        tick: 22,
        dependencies: { terrain: 2, structures: 9 },
      }),
    ).toEqual({ hit: false });
    expect(cache.metrics()).toMatchObject({ invalidations: 1, entries: 0 });
  });

  it("invalidates stale dependency versions across namespaces", () => {
    const manager = new CacheManager();
    const paths = createNamespace(manager, "paths");
    const layouts = createNamespace(manager, "layouts");

    paths.set("old", { room: "old", steps: [] }, { tick: 1, dependencies: { terrain: 1 } });
    paths.set("current", { room: "current", steps: [] }, { tick: 1, dependencies: { terrain: 2 } });
    layouts.set(
      "unrelated",
      { room: "unrelated", steps: [] },
      { tick: 1, dependencies: { controller: "owned" } },
    );

    expect(manager.invalidateDependency("terrain", 2)).toBe(1);
    expect(paths.get("old", { tick: 2, dependencies: { terrain: 1 } })).toEqual({
      hit: false,
    });
    expect(paths.get("current", { tick: 2, dependencies: { terrain: 2 } })).toMatchObject({
      hit: true,
    });
    expect(
      layouts.get("unrelated", {
        tick: 2,
        dependencies: { controller: "owned" },
      }),
    ).toMatchObject({ hit: true });
  });

  it("uses deterministic least-recently-used eviction with a key tie-break", () => {
    const manager = new CacheManager();
    const cache = createNamespace(manager, "bounded", { capacity: 2 });

    cache.set("b", { room: "b", steps: [] }, { tick: 10 });
    cache.set("a", { room: "a", steps: [] }, { tick: 10 });
    cache.set("c", { room: "c", steps: [] }, { tick: 10 });

    expect(cache.get("a", { tick: 10 })).toEqual({ hit: false });
    expect(cache.get("b", { tick: 10 })).toMatchObject({ hit: true });
    expect(cache.get("c", { tick: 10 })).toMatchObject({ hit: true });
    expect(cache.metrics()).toMatchObject({ entries: 2, evictions: 1 });
  });

  it("detaches values at both sides of the codec boundary", () => {
    const manager = new CacheManager();
    const cache = createNamespace(manager, "detached");
    const input = { room: "W4N4", steps: ["up"] };

    cache.set("W4N4", input, { tick: 1 });
    input.steps.push("down");
    const first = cache.get("W4N4", { tick: 1 });
    if (first.hit) {
      (first.value.steps as string[]).push("right");
    }

    expect(cache.get("W4N4", { tick: 1 })).toEqual({
      hit: true,
      value: { room: "W4N4", steps: ["up"] },
    });
  });

  it("enforces encoded-size budgets and measures rebuild CPU through an injected meter", () => {
    const samples = [2, 2.25];
    const manager = new CacheManager({ cpuUsed: () => samples.shift() ?? 2.25 });
    const cache = createNamespace(manager, "budgeted", { maxEncodedLength: 48 });

    expect(cache.getOrCompute("small", { tick: 1 }, () => ({ room: "small", steps: [] }))).toEqual({
      room: "small",
      steps: [],
    });
    expect(cache.metrics()).toMatchObject({
      owner: "test:budgeted",
      buildCpu: 0.25,
      estimatedRebuildCpu: 0.1,
      maxEncodedLength: 48,
    });
    expect(() => {
      cache.set("large", { room: "large", steps: ["x".repeat(64)] }, { tick: 2 });
    }).toThrow(/exceeds/u);
  });

  it("returns the same codec-normalized representation on cold and warm reads", () => {
    const manager = new CacheManager();
    const cache = manager.register<string, string>({
      id: "normalized",
      owner: "test:normalized",
      version: 1,
      capacity: 2,
      maxKeyLength: 128,
      maxEncodedLength: 128,
      estimatedRebuildCpu: 0.1,
      ttlTicks: 10,
      keyOf: (key) => key,
      codec: {
        encode: (value) => value.toLowerCase(),
        decode: (encoded) => encoded,
      },
    });

    expect(cache.getOrCompute("key", { tick: 1 }, () => "MIXED")).toBe("mixed");
    expect(cache.getOrCompute("key", { tick: 2 }, () => "unused")).toBe("mixed");
  });

  it("preserves outputs across heap clears while recording extra work", () => {
    const warm = executePlanner(false);
    const resetEveryTick = executePlanner(true);

    expect(resetEveryTick.outputs).toEqual(warm.outputs);
    expect(warm.computations).toBe(2);
    expect(resetEveryTick.computations).toBe(4);
  });
});

function createNamespace(
  manager: CacheManager,
  id: string,
  options: {
    readonly capacity?: number;
    readonly maxEncodedLength?: number;
    readonly ttlTicks?: number | null;
  } = {},
): CacheNamespace<string, Plan> {
  return manager.register({
    id,
    owner: `test:${id}`,
    version: 1,
    capacity: options.capacity ?? 32,
    maxKeyLength: 512,
    maxEncodedLength: options.maxEncodedLength ?? 4_096,
    estimatedRebuildCpu: 0.1,
    ttlTicks: options.ttlTicks === undefined ? 100 : options.ttlTicks,
    keyOf: (key) => key,
    codec: createJsonCacheCodec<Plan & JsonValue>(),
  });
}

function executePlanner(clearEveryTick: boolean): {
  readonly outputs: readonly Plan[];
  readonly computations: number;
} {
  let manager = new CacheManager();
  let cache = createNamespace(manager, "planner");
  let computations = 0;
  const rooms = ["W1N1", "W1N1", "W2N2", "W1N1"];
  const outputs = rooms.map((room, index) => {
    if (clearEveryTick && index > 0) {
      manager = new CacheManager();
      cache = createNamespace(manager, "planner");
    }
    return cache.getOrCompute(room, { tick: index, dependencies: { world: 7 } }, () => {
      computations += 1;
      return {
        room,
        steps: [`harvest:${room}`, `defend:${room}`],
      };
    });
  });

  return { outputs, computations };
}
