import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../src/cache";
import { FEATURE_GATE_IDS } from "../src/config";
import { runTick } from "../src/runtime/tick";
import { TICK_PHASES, type TickPhase } from "../src/runtime/phases";

describe("tick lifecycle", () => {
  it("runs all phases through the kernel and records bounded tick-local telemetry", () => {
    const observed: TickPhase[] = [];
    const getUsed = vi.fn(() => 1.25);
    const memory = {} as Memory;

    const outcome = runTick({
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
      config: {
        schemaVersion: 1,
        candidate: null,
        lastValid: null,
      },
      kernel: {
        runtime: {
          schemaVersion: 1,
          cpuMode: "normal",
        },
      },
    });
    expect(outcome.configResolution).toEqual({
      status: "source-defaults",
      reasonCode: "owner-initialized",
      candidateRevision: null,
      acceptedCandidateRevision: null,
    });
    expect(Object.isFrozen(outcome.config)).toBe(true);
    expect(Object.isFrozen(outcome.config.policy.recovery)).toBe(true);
    expect(outcome.telemetry).toMatchObject({
      configSourceRevision: outcome.config.sourceRevision,
      configRevision: outcome.config.revision,
      policyRevision: outcome.config.policyRevision,
      configStatus: "source-defaults",
      configReasonCode: "owner-initialized",
    });
    expect(outcome.telemetry?.featureGates.map(({ id }) => id)).toEqual(FEATURE_GATE_IDS);
    expect(outcome.telemetry?.featureGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "phase1.colony", enabled: true, reason: "enabled" }),
      ]),
    );
    expect(outcome.colony).toMatchObject({ status: "planned", colonies: [], objectives: [] });
    expect(outcome.telemetry?.colony).toMatchObject({
      status: "planned",
      activeReservations: 0,
      objectives: 0,
    });
  });

  it("contains a colony planning fault and still executes the mandatory tail", () => {
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
      expect.objectContaining({ systemId: "colony.director", stage: "run" }),
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

  it("activates one valid candidate and retains it after an atomic rejection", () => {
    const memory = {} as Memory;
    const gameAt = (time: number) => ({
      cpu: { bucket: 8_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
      rooms: {},
      shard: { name: "shard3" },
      time,
    });

    runTick({ game: gameAt(60), memory });
    const owner = memory.myrmex?.config as unknown as {
      candidate: unknown;
      lastValid: { candidateRevision: number } | null;
    };
    owner.candidate = {
      revision: 91_001,
      overrides: {
        policy: { recovery: { protectedSpawnEnergy: 450 } },
        relations: { self: ["Myrmex"], allies: ["Friendly"], naps: ["Pact"] },
      },
    };

    const accepted = runTick({ game: gameAt(61), memory });

    expect(accepted.configResolution).toEqual({
      status: "candidate-accepted",
      reasonCode: "candidate-valid",
      candidateRevision: 91_001,
      acceptedCandidateRevision: 91_001,
    });
    expect(accepted.config.policy.recovery.protectedSpawnEnergy).toBe(450);
    expect(accepted.config.relations).toEqual({
      self: ["Myrmex"],
      allies: ["Friendly"],
      naps: ["Pact"],
    });
    const acceptedOwner = memory.myrmex?.config as unknown as {
      candidate: unknown;
      lastValid: { candidateRevision: number } | null;
    };
    expect(acceptedOwner.lastValid?.candidateRevision).toBe(91_001);
    expect(accepted.stateCommit).toMatchObject({ committed: true, owners: ["config", "kernel"] });

    acceptedOwner.candidate = {
      revision: 91_002,
      overrides: {
        policy: { recovery: { protectedSpawnEnergy: 500 } },
        unknownPolicy: true,
      },
    };
    const rejected = runTick({ game: gameAt(62), memory });

    expect(rejected.configResolution).toEqual({
      status: "last-valid-retained",
      reasonCode: "candidate-invalid",
      candidateRevision: 91_002,
      acceptedCandidateRevision: 91_001,
    });
    expect(rejected.config).toEqual(accepted.config);
    expect(rejected.telemetry).toMatchObject({
      configStatus: "last-valid-retained",
      configReasonCode: "candidate-invalid",
      configRevision: accepted.config.revision,
      policyRevision: accepted.config.policyRevision,
    });
    expect(rejected.stateCommit).toMatchObject({ committed: true, owners: ["kernel"] });
    expect(memory.myrmex?.config?.candidate).toMatchObject({ revision: 91_002 });
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
      cpu: { bucket: 10_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
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
          systemId: "cache.sweep",
          consecutiveFailures: 2,
          lastSuccessfulTick: 40,
          nextProbeTick: 100,
        },
        {
          systemId: "cache.sweep",
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
          systemId: "cache.sweep",
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
          systemId: "cache.sweep",
          consecutiveFailures: -1,
          lastSuccessfulTick: 40,
          nextProbeTick: null,
        },
      ],
    };

    const recovered = runTick({ game: gameAt(52), memory });

    expect(recovered.kernel.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "cache.sweep", status: "completed" }),
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
        expect.objectContaining({ systemId: "colony.director", status: "completed" }),
        expect.objectContaining({ systemId: "execution.arbitrate", status: "completed" }),
        expect.objectContaining({ systemId: "state.reconcile", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry.minimum", status: "completed" }),
      ]),
    );
    expect(outcome.stateCommit).toBeNull();
    expect(memory.myrmex).not.toHaveProperty("world");
    expect(outcome.configResolution).toMatchObject({
      status: "owner-unavailable",
      reasonCode: "owner-unavailable",
    });
    expect(outcome.telemetry).toMatchObject({
      configStatus: "owner-unavailable",
      configReasonCode: "owner-unavailable",
      configRevision: outcome.config.revision,
      policyRevision: outcome.config.policyRevision,
      colony: { status: "owner-unavailable" },
    });
  });
});
