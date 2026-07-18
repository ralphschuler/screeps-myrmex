import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { utf8ByteLength } from "../src/config/canonical";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { runTick } from "../src/runtime/tick";
import { establishedRcl2World } from "./support/established-rcl2-fixture";
import { ConsoleReporter } from "../src/telemetry/console-reporter";
import { projectReporterStatus } from "../src/telemetry/reporter-status";
import { TelemetryService } from "../src/telemetry/service";

describe("TelemetryService", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", 101);
    vi.stubGlobal("FIND_SOURCES", 105);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", 106);
    vi.stubGlobal("FIND_STRUCTURES", 107);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", 111);
  });

  afterAll(() => vi.unstubAllGlobals());

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
    expect(next.owner).toMatchObject({ schemaVersion: 5, history: [{ tick: 101 }] });
    expect(next.owner.droppedHistory).toBe(1);
  });

  it("migrates a V4 owner to bounded Phase 2 V5 samples, RCL timing, and attrition state", () => {
    const fixture = serviceFixture(100);
    const result = new TelemetryService().record(
      {
        schemaVersion: 4,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
        staticMining: { schemaVersion: 1, sources: [] },
        logistics: { schemaVersion: 1, flows: [] },
      },
      fixture.input,
    );

    expect(result.owner).toMatchObject({
      schemaVersion: 5,
      phase2: {
        schemaVersion: 5,
        droppedSamples: 0,
        samples: [compactEmptyPhase2Sample(100)],
        rcl: [1, 0, 0, 0, [], []],
      },
    });
    expect((result.owner.phase2 as { attrition?: unknown }).attrition).toBeUndefined();
    expect(ownerBytes(result.owner)).toBeLessThanOrEqual(8_192);
  });

  it("upgrades Phase 2 V1 while dropping samples that lack recipe inputs", () => {
    const fixture = serviceFixture(100);
    const result = new TelemetryService().record(
      {
        schemaVersion: 5,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
        staticMining: { schemaVersion: 1, sources: [] },
        logistics: { schemaVersion: 1, flows: [] },
        phase2: {
          schemaVersion: 1,
          droppedSamples: 0,
          samples: [
            {
              tick: 99,
              harvestedEnergy: 1,
              logisticsDelivered: 2,
              linkDelivered: 3,
              industryOutput: 4,
              authorityFailures: 0,
              reserveViolations: 0,
              measuredCpuMilli: 5,
            },
          ],
        },
      },
      fixture.input,
    );

    expect(result.owner).toMatchObject({
      schemaVersion: 5,
      phase2: {
        schemaVersion: 5,
        droppedSamples: 1,
        samples: [compactEmptyPhase2Sample(100)],
        rcl: [1, 0, 0, 0, [], []],
      },
    });
    expect((result.owner.phase2 as { attrition?: unknown }).attrition).toBeUndefined();
    expect(ownerBytes(result.owner)).toBeLessThanOrEqual(8_192);
  });

  it("rejects oversized compact V4 samples before element traversal", () => {
    const fixture = serviceFixture(100);
    const oversized = new Array(65) as unknown[];
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error("oversized compact sample must not be read");
      },
    });
    const result = new TelemetryService().record(
      {
        schemaVersion: 5,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
        staticMining: { schemaVersion: 1, sources: [] },
        logistics: { schemaVersion: 1, flows: [] },
        phase2: {
          schemaVersion: 4,
          droppedSamples: 0,
          samples: oversized,
          rcl: [1, 0, 0, 0, [], []],
        },
      },
      fixture.input,
    );

    expect(result.owner.phase2).toMatchObject({
      schemaVersion: 5,
      droppedSamples: 65,
      samples: [compactEmptyPhase2Sample(100)],
    });
  });

  it("upgrades Phase 2 V2 timing state to V5 without losing RCL aggregates", () => {
    const fixture = serviceFixture(100);
    const result = new TelemetryService().record(
      {
        schemaVersion: 5,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
        staticMining: { schemaVersion: 1, sources: [] },
        logistics: { schemaVersion: 1, flows: [] },
        phase2: {
          schemaVersion: 2,
          droppedSamples: 0,
          samples: [],
          rcl: [1, 2, 3, 4, [], [[0, 1, 10, 10, 10, 10, 99]]],
        },
      },
      fixture.input,
    );

    expect(result.owner.phase2).toMatchObject({
      schemaVersion: 5,
      rcl: [1, 2, 3, 4, [], [[0, 1, 10, 10, 10, 10, 99]]],
    });
    expect((result.owner.phase2 as { attrition?: unknown }).attrition).toBeUndefined();
  });

  it("isolates malformed compact attrition without discarding valid Phase 2 history", () => {
    const fixture = serviceFixture(100);
    const attrition = new Array(8) as unknown[];
    Object.defineProperty(attrition, 0, {
      get: () => {
        throw new Error("malformed compact attrition");
      },
    });
    const result = new TelemetryService().record(
      {
        schemaVersion: 5,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
        staticMining: { schemaVersion: 1, sources: [] },
        logistics: { schemaVersion: 1, flows: [] },
        phase2: {
          schemaVersion: 5,
          droppedSamples: 0,
          samples: [[99, 1, 2, 3, 6, 7, 4, 0, 0, 5, emptyCooldownRows()]],
          rcl: [1, 0, 0, 0, [], []],
          attrition,
        },
      },
      fixture.input,
    );

    expect(result.owner.phase2).toMatchObject({
      schemaVersion: 5,
      samples: [[99, 1, 2, 3, 6, 7, 4, 0, 0, 5], compactEmptyPhase2Sample(100)],
      rcl: [1, 0, 0, 0, [], []],
    });
    expect((result.owner.phase2 as { attrition?: unknown }).attrition).toBeUndefined();

    const phase2 = {
      schemaVersion: 5,
      droppedSamples: 0,
      samples: [[99, 1, 2, 3, 6, 7, 4, 0, 0, 5, emptyCooldownRows()]],
      rcl: [1, 0, 0, 0, [], []],
    };
    Object.defineProperty(phase2, "attrition", {
      get: () => {
        throw new Error("malformed compact attrition property");
      },
    });
    const propertyResult = new TelemetryService().record(
      {
        schemaVersion: 5,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
        staticMining: { schemaVersion: 1, sources: [] },
        logistics: { schemaVersion: 1, flows: [] },
        phase2,
      },
      fixture.input,
    );
    expect(propertyResult.owner.phase2).toMatchObject({
      samples: [[99, 1, 2, 3, 6, 7, 4, 0, 0, 5], compactEmptyPhase2Sample(100)],
      rcl: [1, 0, 0, 0, [], []],
    });
  });

  it("fits the maximum rolling window under the whole-owner byte ceiling", () => {
    const fixture = serviceFixture(100);
    const service = new TelemetryService();
    let owner: Record<string, unknown> = {};
    for (let tick = 100; tick < 170; tick += 1) {
      owner = service.record(owner, {
        ...fixture.input,
        base: {
          ...fixture.input.base,
          tick,
          telemetryPolicy: {
            ...fixture.input.base.telemetryPolicy,
            maximumHistoryEntries: 64,
          },
        },
      }).owner;
    }

    const phase2 = owner.phase2 as { droppedSamples: number; samples: unknown[] };
    expect(phase2.samples.length).toBeLessThanOrEqual(64);
    expect(phase2.droppedSamples).toBeGreaterThan(0);
    expect(ownerBytes(owner)).toBeLessThanOrEqual(8_192);
  });

  it("keeps populated settled industry and cooldown accounting inside the tick telemetry byte gate", () => {
    const outcome = runTick({ game: establishedRcl2World().game(100), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    const room = outcome.snapshot.ownedRooms[0];
    if (telemetry === null || room === undefined) throw new Error("expected complete fixture");
    const cooldownRoom = {
      ...room,
      ownedLinks: [{ active: true, cooldown: 1 }],
    } as unknown as typeof room;
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
    const result = new TelemetryService().record(
      {},
      {
        base,
        colony: outcome.colony,
        contracts: outcome.contracts,
        execution: outcome.execution,
        growth: [],
        industry: {
          ...telemetry.industry,
          labs: {
            accounting: [20, 45, 15],
            cancelled: 0,
            commands: { executed: 3, failed: 0, rejected: 0 },
            commitments: 3,
            intents: 3,
            readinessBlockers: 0,
            resourceDemands: 0,
            retries: 0,
            settledAmount: 7,
          },
          mature: {
            accounting: { factory: [40, 100, 20], powerProcessing: [150, 3, 3] },
            commands: { executed: 2, failed: 0, rejected: 0 },
            intents: { factory: 1, powerProcessing: 1, total: 2 },
            settlements: { cancelled: 0, pending: 0, retries: 0 },
            truncated: false,
          },
        },
        maintenance: [],
        movement: outcome.movement,
        reporterSignals: [],
        snapshot: {
          ...outcome.snapshot,
          ownedRooms: [cooldownRoom],
          rooms: [cooldownRoom],
        },
        spawn: outcome.spawn,
      },
    );

    expect(result.telemetry.industry.labs?.accounting).toEqual([20, 45, 15]);
    expect(result.telemetry.industry.mature?.accounting).toEqual({
      factory: [40, 100, 20],
      powerProcessing: [150, 3, 3],
    });
    expect(result.telemetry.phase2.cooldowns?.current[1]).toEqual([1, 1, 10_000]);
    expect(
      (result.owner.phase2 as unknown as { samples: readonly (readonly unknown[])[] })
        .samples[0]?.[10],
    ).toEqual([
      [0, 0],
      [1, 1],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(utf8Bytes(result.telemetry)).toBeLessThanOrEqual(8_192);
  });

  it("evicts one complete attrition baseline without fabricating structure loss", () => {
    const outcome = runTick({ game: establishedRcl2World().game(100), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    const room = outcome.snapshot.ownedRooms[0];
    if (telemetry === null || room === undefined) throw new Error("expected complete fixture");
    const roadCount = 128 - room.storedStructures.length;
    const roads = Array.from({ length: roadCount }, (_, index) => ({
      id: `road-${String(index)}`,
      hits: 5_000,
      hitsMax: 5_000,
      pos: { roomName: room.name, x: index % 50, y: Math.floor(index / 50) },
      ticksToDecay: 1_000,
    }));
    const observedRoom = { ...room, roads };
    const snapshot = {
      ...outcome.snapshot,
      ownedRooms: [observedRoom],
      rooms: [observedRoom],
    };
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
    const input = {
      base: {
        ...base,
        telemetryPolicy: { ...base.telemetryPolicy, maximumHistoryBytes: 512 },
      },
      colony: outcome.colony,
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot,
      spawn: outcome.spawn,
      reporterSignals: [],
    } as const;
    const service = new TelemetryService();
    const first = service.record({}, input);
    const replay = service.record(first.owner, input);
    const failedReplay = service.record(first.owner, {
      ...input,
      industry: {
        ...telemetry.industry,
        labs: {
          accounting: [-1, 0, 0],
          cancelled: 0,
          commands: { executed: 0, failed: 0, rejected: 0 },
          commitments: 0,
          intents: 0,
          readinessBlockers: 0,
          resourceDemands: 0,
          retries: 0,
          settledAmount: 0,
        },
      },
    });
    const attrition = (first.owner.phase2 as { attrition: unknown[] }).attrition;

    expect(attrition.slice(0, 7)).toEqual([1, null, roadCount, 0, 0, [], []]);
    expect(first.telemetry.phase2.attrition).toMatchObject({
      rows: [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
      ],
      interruptedAssets: roadCount,
      droppedRows: 0,
    });
    expect(replay.owner.phase2).toEqual(first.owner.phase2);
    expect(failedReplay.owner.phase2).toEqual(first.owner.phase2);
    expect(replay.telemetry.phase2.attrition).toEqual(first.telemetry.phase2.attrition);
    expect(failedReplay.telemetry.phase2.attrition).toEqual(first.telemetry.phase2.attrition);
    expect(ownerBytes(first.owner)).toBeLessThanOrEqual(512);
  });

  it("drops completed RCL aggregates before reporter evidence under byte pressure", () => {
    const fixture = serviceFixture(100);
    const duration = [1, 100, 100, 100, 100, 100] as const;
    const result = new TelemetryService().record(
      {
        schemaVersion: 5,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 2,
          entries: { schemaVersion: 1, entries: [] },
          recovery: null,
        },
        staticMining: { schemaVersion: 1, sources: [] },
        logistics: { schemaVersion: 1, flows: [] },
        phase2: {
          schemaVersion: 2,
          droppedSamples: 0,
          samples: [],
          rcl: [1, 0, 0, 0, [], Array.from({ length: 7 }, (_, index) => [index, ...duration])],
        },
      },
      {
        ...fixture.input,
        base: {
          ...fixture.input.base,
          telemetryPolicy: {
            ...fixture.input.base.telemetryPolicy,
            maximumHistoryBytes: 512,
          },
        },
      },
    );
    const phase2 = result.owner.phase2 as {
      rcl: [number, number, number, number, unknown[], unknown[]];
    };

    expect(phase2.rcl[3]).toBe(7);
    expect(phase2.rcl[5]).toEqual([]);
    expect(result.telemetry.phase2.progression.rcl).toEqual([
      null,
      0,
      0,
      null,
      null,
      null,
      null,
      0,
      0,
      7,
    ]);
    expect(result.owner.last).toMatchObject({ hash: result.telemetry.status.hash });
    expect(ownerBytes(result.owner)).toBeLessThanOrEqual(512);
  });

  it("keeps fitted Phase 2 evidence idempotent on same-tick replay", () => {
    const outcome = runTick({ game: establishedRcl2World().game(100), memory: {} as Memory });
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
    const input = {
      base: {
        ...base,
        telemetryPolicy: { ...base.telemetryPolicy, maximumHistoryBytes: 512 },
      },
      colony: outcome.colony,
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
      reporterSignals: [],
    } as const;
    const service = new TelemetryService();
    const first = service.record({}, input);
    const replay = service.record(first.owner, input);

    expect(ownerBytes(first.owner)).toBeLessThanOrEqual(512);
    expect(replay.owner.phase2).toEqual(first.owner.phase2);
    expect(replay.telemetry.phase2).toEqual(first.telemetry.phase2);
    expect(replay.telemetry.status.hash).toBe(first.telemetry.status.hash);
    expect(replay.owner.last).toMatchObject({ hash: replay.telemetry.status.hash });
  });

  it("publishes a stable redacted reason for funded contracts without a viable actor", () => {
    const outcome = runTick({ game: game(100), memory: {} as Memory });
    if (outcome.telemetry === null || outcome.contracts === null)
      throw new Error("expected telemetry and contract reconciliation");
    const service = new TelemetryService();
    const result = service.record(
      {},
      {
        base: outcome.telemetry,
        colony: outcome.colony,
        contracts: {
          ...outcome.contracts,
          allocation: {
            ...outcome.contracts.allocation,
            deferred: [
              { contractId: "secret-bootstrap-contract", reason: "no-viable-actor" as const },
            ],
          },
        },
        execution: outcome.execution,
        growth: [],
        maintenance: [],
        movement: outcome.movement,
        snapshot: outcome.snapshot,
        spawn: outcome.spawn,
        reporterSignals: [],
      },
    );
    const deferred = result.telemetry.status.details.find(
      ({ domain, status }) => domain === "contract" && status === "deferred",
    );
    expect(deferred).toMatchObject({ reason: "no-viable-actor" });
    expect(deferred?.entityId).toMatch(/^contract:[0-9a-f]{8}$/);
    expect(JSON.stringify(result.telemetry)).not.toContain("secret-bootstrap-contract");
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
    expect(first.owner).toMatchObject({ schemaVersion: 5, staticMining: { schemaVersion: 1 } });
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

function emptyCooldownRows() {
  return [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
}

function compactEmptyPhase2Sample(tick: number) {
  return [tick, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

function ownerBytes(owner: unknown): number {
  return JSON.stringify(owner).length;
}

function utf8Bytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
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
