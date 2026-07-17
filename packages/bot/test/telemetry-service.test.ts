import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { runTick } from "../src/runtime/tick";
import { ConsoleReporter } from "../src/telemetry/console-reporter";
import { projectReporterStatus } from "../src/telemetry/reporter-status";
import { TelemetryService } from "../src/telemetry/service";

describe("TelemetryService", () => {
  it("canonicalizes capped details and retains only a bounded observer history", () => {
    const outcome = runTick({ game: game(100), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const base = telemetry;
    const service = new TelemetryService();
    const decisions = [
      {
        reservationId: "z-budget",
        colonyId: "W1N1",
        category: "optional-growth",
        issuer: "growth/z",
        revision: 1,
        status: "denied",
        reasonCode: "insufficient-energy",
        grant: null,
      },
      {
        reservationId: "a-budget",
        colonyId: "W1N1",
        category: "optional-growth",
        issuer: "growth/a",
        revision: 1,
        status: "denied",
        reasonCode: "insufficient-cpu",
        grant: null,
      },
    ] as const;
    const input = {
      base: {
        ...base,
        telemetryPolicy: {
          ...base.telemetryPolicy,
          maximumDetailRecords: 1,
          maximumHistoryEntries: 1,
        },
      },
      colony: { ...outcome.colony, decisions },
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
      reporterSignals: [],
    } as const;

    const first = service.record({}, input);
    const reversed = service.record(
      {},
      { ...input, colony: { ...input.colony, decisions: [...decisions].reverse() } },
    );
    expect(first.telemetry.status).toEqual(reversed.telemetry.status);
    expect(first.telemetry.status.details).toHaveLength(1);
    const [detail] = first.telemetry.status.details;
    expect(detail).toMatchObject({ domain: "budget", status: "denied" });
    expect(detail?.entityId).toMatch(/^budget:[0-9a-f]{8}$/);
    expect(detail?.entityId).not.toContain("a-budget");
    expect(first.telemetry.status.droppedDetails).toBe(1);

    const next = service.record(first.owner, {
      ...input,
      base: { ...input.base, tick: 101 },
    });
    expect(next.owner).toMatchObject({ schemaVersion: 4, history: [{ tick: 101 }] });
    expect(next.owner.droppedHistory).toBe(1);
  });

  it("publishes bounded recovery transitions while Memory is ready without persisting a queue", () => {
    const outcome = runTick({ game: game(100), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const {
      activity: _activity,
      recoveryProgress: _recoveryProgress,
      reporterTransitions: _reporterTransitions,
      status: _status,
      ...base
    } = telemetry;
    void _activity;
    void _recoveryProgress;
    void _reporterTransitions;
    void _status;
    const service = new TelemetryService();
    const denied = {
      reservationId: "secret-W1N1-recovery-budget",
      colonyId: "W1N1",
      category: "emergency-spawn",
      issuer: "colony/W1N1/restore-workforce",
      revision: 1,
      status: "denied",
      reasonCode: "insufficient-energy",
      grant: null,
    } as const;
    const inputAt = (tick: number) => ({
      base: {
        ...base,
        tick,
        memoryStatus: "ready" as const,
        colony: {
          ...base.colony,
          states: base.colony.states.map((state) => ({
            ...state,
            count: state.id === "bootstrapping" ? 1 : 0,
          })),
        },
        reporterPolicy: {
          ...base.reporterPolicy,
          initialReminderDelayTicks: 2,
          maximumImmediateEventsPerTick: 2,
          maximumReminderDelayTicks: 8,
          stuckRecoveryWindowTicks: 3,
        },
      },
      colony: { ...outcome.colony, decisions: [denied] },
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
      reporterSignals: [],
    });

    const first = service.record({}, inputAt(10));
    const reminder = service.record(first.owner, inputAt(12));
    const stuck = service.record(reminder.owner, inputAt(13));

    expect(first.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(reminder.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "reminder", count: 2 }),
    ]);
    expect(stuck.telemetry.recoveryProgress).toMatchObject({
      stuck: true,
      lastProgressTick: 10,
      reminderAtTick: 15,
    });
    expect(stuck.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({
        category: "recovery",
        kind: "stuck",
        owner: "colony",
        blockerReasonCode: "insufficient-energy",
        lastProgressTick: 10,
        reminderAtTick: 15,
        reasonCode: "recovery-progress-unchanged",
      }),
    ]);
    const recoveryTransition = stuck.telemetry.reporterTransitions.find(
      (transition) => transition.category === "recovery",
    );
    expect(recoveryTransition?.blockerRef).toMatch(/^recovery-blocker:[0-9a-f]{8}$/);
    expect(stuck.owner).not.toHaveProperty("reporter.events");
    expect(JSON.stringify(stuck.owner)).not.toContain("secret-W1N1-recovery-budget");
    const reporterPolicy = {
      ...buildRuntimeConfig().policy.reporter,
      heartbeatIntervalTicks: 10,
      maximumReminderDelayTicks: 8,
    };
    const status = projectReporterStatus(
      stuck.telemetry,
      { ...outcome.kernel, tick: 13 },
      reporterPolicy,
    );
    const lines = new ConsoleReporter().report(status, reporterPolicy, { log: () => undefined });
    expect(status.transitions).toEqual([
      expect.objectContaining({
        category: "recovery",
        kind: "stuck",
        owner: "colony",
        lastProgressTick: 10,
        reminderAtTick: 15,
      }),
    ]);
    expect(lines[0]).toContain("reporter recovery kind=stuck owner=colony");
    expect(lines[0]).toContain("reason=recovery-progress-unchanged");
    expect(lines.join("\n")).not.toContain("W1N1");

    const future = service.record(
      {
        ...stuck.owner,
        reporter: {
          schemaVersion: 2,
          entries: {
            schemaVersion: 99,
            entries: [
              {
                fingerprint: "fault:deadbeef",
                count: 50,
                lastTick: 1,
                nextReminderTick: 2,
                reasonCode: "unexpected-exception",
              },
            ],
          },
          recovery: { signature: "future-player-value" },
        },
      },
      inputAt(14),
    );
    expect(future.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(future.telemetry.recoveryProgress).toMatchObject({
      stuck: false,
      lastProgressTick: 14,
    });
    expect(JSON.stringify(future)).not.toContain("future-player-value");
  });

  it("retains the configured fingerprint cardinality when it fits and evicts deterministically by bytes", () => {
    const fixture = serviceFixture(100);
    const service = new TelemetryService();
    const ordinarySignals = Array.from({ length: 2_000 }, (_, index) => ({
      kind: "fault",
      identity: `hostile-room-${String(index)}`,
      reasonCode: "unexpected-exception",
    }));
    const ordinary = service.record({}, { ...fixture.input, reporterSignals: ordinarySignals });
    expect(reporterEntries(ordinary.owner)).toHaveLength(64);
    expect(ownerBytes(ordinary.owner)).toBeLessThanOrEqual(8_192);

    const widestSafeCode = `a${"-".repeat(63)}`;
    let sourceIdentityReads = 0;
    const wideSignals = Array.from({ length: 2_000 }, (_, index) => {
      const signal = {
        kind: "a".repeat(32),
        reasonCode: widestSafeCode,
      } as {
        kind: string;
        identity: string;
        reasonCode: string;
      };
      Object.defineProperty(signal, "identity", {
        enumerable: true,
        get: () => {
          sourceIdentityReads += 1;
          return `hostile-room-${String(index)}`;
        },
      });
      return signal;
    });
    const forward = service.record({}, { ...fixture.input, reporterSignals: wideSignals });
    expect(sourceIdentityReads).toBe(2_000);
    const reversed = service.record(
      {},
      { ...fixture.input, reporterSignals: [...wideSignals].reverse() },
    );
    expect(forward.owner).toEqual(reversed.owner);
    expect(forward.telemetry.reporterTransitions).toEqual(reversed.telemetry.reporterTransitions);
    expect(reporterEntries(forward.owner).length).toBeGreaterThan(24);
    expect(reporterEntries(forward.owner).length).toBeLessThan(64);
    expect(ownerBytes(forward.owner)).toBeLessThanOrEqual(8_192);
    expect(JSON.stringify(forward.owner)).not.toContain("hostile-room");

    const byteLimitedSignals = wideSignals.slice(0, 64);
    const byteLimitedFirst = service.record(
      {},
      { ...fixture.input, reporterSignals: byteLimitedSignals },
    );
    const byteLimitedEntries = reporterEntries(byteLimitedFirst.owner) as readonly {
      readonly fingerprint?: string;
    }[];
    expect(byteLimitedEntries.length).toBeLessThan(64);
    expect(
      byteLimitedEntries.some(({ fingerprint }) => fingerprint?.startsWith("reporter-overflow:")),
    ).toBe(true);
    expect(byteLimitedFirst.telemetry.reporterTransitions[0]).toMatchObject({
      category: "signal",
      kind: "first",
      reasonCode: "reporter-cardinality-overflow",
    });
    expect(ownerBytes(byteLimitedFirst.owner)).toBeLessThanOrEqual(8_192);

    const byteLimitedQuiet = service.record(byteLimitedFirst.owner, {
      ...fixture.input,
      base: { ...fixture.input.base, tick: 101 },
      reporterSignals: byteLimitedSignals,
    });
    expect(byteLimitedQuiet.telemetry.reporterTransitions).toEqual([]);

    const byteLimitedReminder = service.record(byteLimitedQuiet.owner, {
      ...fixture.input,
      base: { ...fixture.input.base, tick: 110 },
      reporterSignals: byteLimitedSignals,
    });
    expect(byteLimitedReminder.telemetry.reporterTransitions[0]).toMatchObject({
      category: "signal",
      kind: "reminder",
      count: 2,
      reasonCode: "reporter-cardinality-overflow",
    });
    expect(ownerBytes(byteLimitedReminder.owner)).toBeLessThanOrEqual(8_192);

    const recoveryBase = {
      ...fixture.input.base,
      telemetryPolicy: { ...fixture.input.base.telemetryPolicy, maximumHistoryEntries: 0 },
      colony: {
        ...fixture.input.base.colony,
        states: fixture.input.base.colony.states.map((state) => ({
          ...state,
          count: state.id === "bootstrapping" ? 1 : 0,
        })),
      },
      reporterPolicy: {
        ...fixture.input.base.reporterPolicy,
        stuckRecoveryWindowTicks: 10,
      },
    };
    const recoveryFirst = service.record(
      {},
      {
        ...fixture.input,
        base: recoveryBase,
        reporterSignals: byteLimitedSignals,
      },
    );
    const ownerWithMissingOrdinary = JSON.parse(JSON.stringify(recoveryFirst.owner)) as {
      reporter: { entries: { entries: { fingerprint: string }[] } };
    };
    const recoveryEntries = ownerWithMissingOrdinary.reporter.entries.entries;
    const removable = recoveryEntries
      .map(({ fingerprint }, index) => ({ fingerprint, index }))
      .filter(({ fingerprint }) => !fingerprint.startsWith("reporter-overflow:"))
      .slice(-2)
      .map(({ index }) => index);
    ownerWithMissingOrdinary.reporter.entries.entries = recoveryEntries.filter(
      (_entry, index) => !removable.includes(index),
    );
    const mixedPriority = service.record(ownerWithMissingOrdinary, {
      ...fixture.input,
      base: { ...recoveryBase, tick: 110 },
      reporterSignals: byteLimitedSignals,
    });
    expect(mixedPriority.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "recovery", kind: "stuck" }),
      expect.objectContaining({
        category: "signal",
        kind: "reminder",
        reasonCode: "reporter-cardinality-overflow",
      }),
    ]);
  });

  it("prioritizes current first evidence ahead of a resolution flood", () => {
    const fixture = serviceFixture(100);
    const service = new TelemetryService();
    const previous = service.record(
      {},
      {
        ...fixture.input,
        reporterSignals: Array.from({ length: 64 }, (_, index) => ({
          kind: "fault",
          identity: `prior-system-${String(index)}`,
          reasonCode: "unexpected-exception",
        })),
      },
    );

    const current = service.record(previous.owner, {
      ...fixture.input,
      base: { ...fixture.input.base, tick: 101 },
      reporterSignals: [
        { kind: "fault", identity: "current-critical-system", reasonCode: "unexpected-exception" },
      ],
    });

    expect(current.telemetry.reporterTransitions).toHaveLength(2);
    expect(current.telemetry.reporterTransitions[0]).toMatchObject({
      category: "signal",
      kind: "first",
      count: 1,
    });
    expect(current.telemetry.reporterTransitions[1]).toMatchObject({
      category: "signal",
      kind: "resolved",
    });
    expect(JSON.stringify(current)).not.toContain("current-critical-system");
  });

  it("rejects oversized durable arrays before traversal and saturates dropped history", () => {
    const fixture = serviceFixture(100);
    const oversizedHistory = new Array(17) as unknown[];
    Object.defineProperty(oversizedHistory, 0, {
      get: () => {
        throw new Error("oversized history entry must not be read");
      },
    });
    const oversizedEntries = new Array(65) as unknown[];
    Object.defineProperty(oversizedEntries, 0, {
      get: () => {
        throw new Error("oversized reporter entry must not be read");
      },
    });
    const result = new TelemetryService().record(
      {
        schemaVersion: 2,
        history: oversizedHistory,
        droppedHistory: Number.MAX_SAFE_INTEGER,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: oversizedEntries },
          recovery: null,
        },
      },
      {
        ...fixture.input,
        reporterSignals: [
          { kind: "fault", identity: "system-a", reasonCode: "unexpected-exception" },
        ],
      },
    );
    expect(result.owner.droppedHistory).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(ownerBytes(result.owner)).toBeLessThanOrEqual(8_192);
  });

  it("keeps reset-safe static mining samples inside the sole bounded telemetry owner", () => {
    const fixture = serviceFixture(100);
    const service = new TelemetryService();
    const observations = Array.from({ length: 66 }, (_, index) => ({
      sourceId: `source-${String(index).padStart(2, "0")}`,
      energy: 3_000,
      energyCapacity: 3_000,
      ticksToRegeneration: 100,
      minerState: "active" as const,
      container: { capacity: 2_000, used: 500, ticksToDecay: 4_000 },
    }));
    const first = service.record(
      {
        schemaVersion: 2,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
      },
      { ...fixture.input, staticMining: { cpuUsed: 2, observations } },
    );
    expect(first.owner).toMatchObject({ schemaVersion: 4, staticMining: { schemaVersion: 1 } });
    expect(first.telemetry.staticMining).toMatchObject({
      observedSources: 64,
      droppedSources: 2,
      sourceUptimeTicks: 64,
      cpuUsed: 2,
      cpuPerHarvestedEnergy: null,
    });
    expect(ownerBytes(first.owner)).toBeLessThanOrEqual(8_192);

    const next = service.record(first.owner, {
      ...fixture.input,
      base: { ...fixture.input.base, tick: 101 },
      staticMining: {
        cpuUsed: 1,
        observations: observations.map((source) => ({ ...source, energy: 2_990 })),
      },
    });
    expect(next.telemetry.staticMining).toMatchObject({
      harvestedEnergy: 640,
      cpuPerHarvestedEnergy: 1 / 640,
    });

    const reset = service.record(
      {},
      {
        ...fixture.input,
        base: { ...fixture.input.base, tick: 101 },
        staticMining: { cpuUsed: 1, observations: observations.slice(0, 1) },
      },
    );
    expect(reset.telemetry.staticMining.harvestedEnergy).toBe(0);
  });

  it("isolates reporter aggregation and recovery state exceptions with empty safe output", () => {
    const fixture = serviceFixture(100);
    const hostileSignal = { kind: "fault", reasonCode: "unexpected-exception" } as {
      kind: string;
      identity: string;
      reasonCode: string;
    };
    Object.defineProperty(hostileSignal, "identity", {
      get: () => {
        throw new Error("reporter aggregation failed");
      },
    });
    const hostileRecovery = {};
    Object.defineProperty(hostileRecovery, "signature", {
      get: () => {
        throw new Error("recovery parsing failed");
      },
    });
    const result = new TelemetryService().record(
      {
        schemaVersion: 2,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: hostileRecovery,
        },
      },
      { ...fixture.input, reporterSignals: [hostileSignal] },
    );
    expect(reporterEntries(result.owner)).toEqual([]);
    expect(result.owner).toMatchObject({ reporter: { recovery: null } });
    expect(result.telemetry.recoveryProgress).toBeNull();
    expect(result.telemetry.reporterTransitions).toEqual([]);
    expect(ownerBytes(result.owner)).toBeLessThanOrEqual(8_192);
  });
});

function serviceFixture(time: number) {
  const outcome = runTick({ game: game(time), memory: {} as Memory });
  const telemetry = outcome.telemetry;
  if (telemetry === null) throw new Error("expected telemetry");
  const {
    activity: _activity,
    recoveryProgress: _recoveryProgress,
    reporterTransitions: _reporterTransitions,
    status: _status,
    ...base
  } = telemetry;
  void _activity;
  void _recoveryProgress;
  void _reporterTransitions;
  void _status;
  return {
    input: {
      base,
      colony: outcome.colony,
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
      reporterSignals: [],
    },
  };
}

function reporterEntries(owner: Record<string, unknown>): readonly unknown[] {
  const reporter = owner.reporter as { entries?: { entries?: readonly unknown[] } } | undefined;
  return reporter?.entries?.entries ?? [];
}

function ownerBytes(owner: unknown): number {
  return JSON.stringify(owner).length;
}

function game(time: number) {
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: {},
    rooms: {},
    shard: { name: "shard3" },
    time,
  };
}
