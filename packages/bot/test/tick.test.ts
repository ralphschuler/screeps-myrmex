import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../src/cache";
import { runTick } from "../src/runtime/tick";
import { TICK_PHASES, type TickPhase } from "../src/runtime/phases";

describe("tick lifecycle", () => {
  it("runs all phases through the kernel and records bounded tick-local telemetry", () => {
    const observed: TickPhase[] = [];
    const getUsed = vi.fn(() => 1.25);
    const memory = {} as Memory;

    runTick({
      game: {
        cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed },
        rooms: {},
        shard: { name: "shard3" },
        time: 42,
      },
      memory,
      onPhase: (phase) => observed.push(phase),
    });

    expect(observed).toEqual(TICK_PHASES);
    expect(memory.myrmex).not.toHaveProperty("world");
    expect(memory.myrmex?.meta.lastTick).toBe(42);
    expect(memory.myrmex?.meta.revision).toBe(1);
    expect(memory.myrmex).toMatchObject({
      kernel: {
        runtime: {
          schemaVersion: 1,
          cpuMode: "normal",
        },
      },
    });
  });

  it("contains an optional planning fault and still executes the mandatory tail", () => {
    const observed: TickPhase[] = [];
    const memory = {} as Memory;

    const outcome = runTick({
      game: {
        cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        rooms: {},
        shard: { name: "shard3" },
        time: 43,
      },
      memory,
      onPhase: (phase) => {
        observed.push(phase);
        if (phase === "plan") {
          throw new Error("injected planner fault");
        }
      },
    });

    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ systemId: "planning.foundation", stage: "run" }),
    ]);
    expect(observed).toEqual(TICK_PHASES);
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "execution.arbitrate", status: "completed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toMatchObject({ committed: true });
    expect(outcome.kernel.faults).toHaveLength(1);
    expect(outcome.telemetry).toMatchObject({ memoryStatus: "ready", ownedRooms: 0 });
  });

  it("accounts Memory preflight as overhead and cache telemetry inside its system", () => {
    let used = 0;
    let firstReading = true;
    const getUsed = vi.fn(() => {
      const reading = used;
      if (firstReading) {
        firstReading = false;
        used = 2;
      }
      return reading;
    });
    const metricsDescriptor = Object.getOwnPropertyDescriptor(CacheManager.prototype, "metrics");
    if (typeof metricsDescriptor?.value !== "function") {
      throw new TypeError("CacheManager.metrics descriptor is unavailable");
    }
    const originalMetrics = metricsDescriptor.value as (
      this: CacheManager,
    ) => ReturnType<CacheManager["metrics"]>;
    let metricsCalls = 0;
    const metricsSpy = vi.spyOn(CacheManager.prototype, "metrics").mockImplementation(function (
      this: CacheManager,
    ) {
      metricsCalls += 1;
      used += 0.75;
      return originalMetrics.call(this);
    });
    const outcome = (() => {
      try {
        return runTick({
          game: {
            cpu: {
              bucket: 8_000,
              limit: 20,
              tickLimit: 500,
              getUsed,
            },
            rooms: {},
            shard: { name: "shard3" },
            time: 45,
          },
          memory: {} as Memory,
        });
      } finally {
        metricsSpy.mockRestore();
      }
    })();

    const telemetrySystem = outcome.kernel.systems.find(
      ({ systemId }) => systemId === "telemetry.minimum",
    );
    const phaseCpu = outcome.kernel.phases.reduce((total, phase) => total + phase.cpuUsed, 0);
    expect(metricsCalls).toBe(1);
    expect(outcome.kernel.cpu.usedAtStart).toBe(0);
    expect(telemetrySystem).toMatchObject({ status: "completed", cpuUsed: 0.75 });
    expect(outcome.kernel.cpuUsed).toBe(2.75);
    expect(outcome.kernel.overheadCpu).toBe(2);
    expect(phaseCpu + outcome.kernel.overheadCpu).toBe(outcome.kernel.cpuUsed);
    expect(outcome.telemetry).toMatchObject({ cacheEntries: 0, cacheNamespaces: 0 });
  });

  it("returns the kernel report when the mandatory telemetry system itself faults", () => {
    const outcome = runTick({
      game: {
        cpu: {
          bucket: 8_000,
          limit: 20,
          tickLimit: 500,
          getUsed: () => 0,
        },
        rooms: {},
        shard: { name: "shard3" },
        time: 46,
      },
      memory: {} as Memory,
      onPhase: (phase) => {
        if (phase === "telemetry") {
          throw new Error("injected telemetry fault");
        }
      },
    });

    expect(outcome.telemetry).toBeNull();
    expect(outcome.stateCommit).toMatchObject({ committed: true });
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "failed" }),
      ]),
    );
    expect(outcome.kernel.faults).toEqual([
      expect.objectContaining({ systemId: "telemetry.minimum", stage: "run" }),
    ]);
  });

  it("continues boot with retired, duplicate, or malformed persisted kernel health", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      rooms: {},
      shard: { name: "shard3" },
      time,
    });

    runTick({ game: gameAt(50), memory });
    (memory.myrmex as unknown as { kernel: { runtime: unknown } }).kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "normal",
      health: [
        {
          systemId: "retired.system",
          consecutiveFailures: 1,
          lastSuccessfulTick: 40,
          nextProbeTick: null,
        },
        {
          systemId: "planning.foundation",
          consecutiveFailures: 2,
          lastSuccessfulTick: 40,
          nextProbeTick: 100,
        },
        {
          systemId: "planning.foundation",
          consecutiveFailures: 3,
          lastSuccessfulTick: 41,
          nextProbeTick: 200,
        },
      ],
    };

    const restored = runTick({ game: gameAt(51), memory });

    expect(restored.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systemId: "planning.foundation",
          status: "skipped",
          skipReason: "quarantined",
          nextEligibleTick: 100,
        }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(restored.stateCommit).toMatchObject({ committed: true });

    (memory.myrmex as unknown as { kernel: { runtime: unknown } }).kernel.runtime = {
      schemaVersion: 1,
      cpuMode: "normal",
      health: [
        {
          systemId: "planning.foundation",
          consecutiveFailures: -1,
          lastSuccessfulTick: 40,
          nextProbeTick: null,
        },
      ],
    };

    const recovered = runTick({ game: gameAt(52), memory });

    expect(recovered.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "planning.foundation", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(recovered.stateCommit).toMatchObject({ committed: true });
  });

  it("uses recovery admission while an interrupted migration advances", () => {
    const memory = {
      myrmex: {
        schema: 1,
        boot: { firstTick: 1, lastTick: 40, shard: "shard3" },
        world: { stale: true },
      },
    } as unknown as Memory;

    const outcome = runTick({
      game: {
        cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
        rooms: {},
        shard: { name: "shard3" },
        time: 44,
      },
      memory,
    });

    expect(outcome.memoryStatus).toBe("recovery");
    expect(outcome.kernel.mode).toBe("recovery");
    expect(outcome.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "planning.foundation", skipReason: "cpu-mode" }),
        expect.objectContaining({ systemId: "execution.arbitrate", status: "completed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toBeNull();
    expect(memory.myrmex).not.toHaveProperty("world");
  });
});
