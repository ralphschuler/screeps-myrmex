import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import { establishedRcl2World } from "./support/established-rcl2-fixture";
import {
  MAX_PHASE2_CONTROLLER_TRACKERS,
  PHASE2_AUTHORITY_IDS,
  PHASE2_RCL_DESTINATIONS,
  reducePhase2Telemetry,
  type Phase2TelemetryObservation,
  type Phase2TelemetryState,
} from "../src/telemetry/phase2";

describe("Phase 2 telemetry reducer", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", 101);
    vi.stubGlobal("FIND_SOURCES", 105);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", 106);
    vi.stubGlobal("FIND_STRUCTURES", 107);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", 111);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("publishes fixed authority outcomes and reconciled flow identities", () => {
    const result = reducePhase2Telemetry({
      observation: observation(100),
      previous: null,
      maximumSamples: 4,
    });

    expect(result.telemetry.authorities).toHaveLength(PHASE2_AUTHORITY_IDS.length);
    expect(result.telemetry.authorities[0]).toEqual([1, 1, 1, 400, 0, 100, 9]);
    expect(result.telemetry.flows).toMatchObject({
      harvestedEnergy: 20,
      logistics: { requested: 80, scheduled: 60, shortfall: 20, delivered: 50, loss: 3 },
      links: { sent: 40, delivered: 38, lost: 2 },
      maintenanceEnergy: 15,
      terminalTransactionEnergyPlanned: 4,
      labOutput: 5,
      factoryOutput: 6,
      powerOutput: 7,
    });
    expect(result.telemetry.identities).toEqual([
      [true, 0],
      [true, 0],
      [true, 5],
    ]);
    expect(result.telemetry.window).toEqual([1, 100, 100, 20, 50, 38, 18, 10, 1, 250, 0]);
    expect(Object.isFrozen(result.telemetry.authorities)).toBe(true);
  });

  it("keeps a deterministic bounded rolling window across JSON reset", () => {
    const first = reducePhase2Telemetry({
      observation: observation(100),
      previous: null,
      maximumSamples: 2,
    });
    const reset = JSON.parse(JSON.stringify(first.state)) as Phase2TelemetryState;
    const second = reducePhase2Telemetry({
      observation: { ...observation(101), harvestedEnergy: 30 },
      previous: reset,
      maximumSamples: 2,
    });
    const third = reducePhase2Telemetry({
      observation: { ...observation(102), harvestedEnergy: 40 },
      previous: second.state,
      maximumSamples: 2,
    });

    expect(third.state.samples.map(({ tick }) => tick)).toEqual([101, 102]);
    expect(third.telemetry.window).toEqual([2, 101, 102, 70, 100, 76, 36, 20, 2, 500, 1]);
    const replay = reducePhase2Telemetry({
      observation: { ...observation(102), harvestedEnergy: 40 },
      previous: second.state,
      maximumSamples: 2,
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(third));
  });

  it("composes byte-equivalent gate inputs from reordered runtime observations", () => {
    const memory = {} as Memory;
    const forward = runTick({
      game: establishedRcl2World().game(100),
      memory,
    });
    const reversed = runTick({
      game: establishedRcl2World({ reverseCollections: true }).game(100),
      memory: {} as Memory,
    });

    expect(forward.telemetry?.phase2).toEqual(reversed.telemetry?.phase2);
    const persistedPhase2 = JSON.stringify(memory.myrmex?.telemetry?.phase2);
    expect(persistedPhase2).not.toContain("W1N1");
    expect(persistedPhase2).toMatch(/colony:[0-9a-f]{8}/u);
    expect(forward.telemetry?.phase2).toMatchObject({
      progression: {
        controllers: 1,
        rcl8Controllers: 0,
        controllerProgress: 0,
        controllerProgressTotal: 1_000,
        minimumDowngradeTicks: 20_000,
      },
      reserves: { energyAvailable: 300, energyCapacity: 400 },
      spawn: { active: 1 },
      construction: { backlog: 1, progressRemaining: 95 },
    });
  });

  it("persists and restores the bounded window through the runtime telemetry owner", () => {
    const memory = {} as Memory;
    const first = runTick({ game: game(100), memory });
    const second = runTick({ game: game(101), memory });
    if (first.telemetry === null || second.telemetry === null)
      throw new Error("expected telemetry");

    expect(first.telemetry.phase2.window.slice(0, 3)).toEqual([1, 100, 100]);
    expect(second.telemetry.phase2.window.slice(0, 3)).toEqual([2, 100, 101]);
    expect(memory.myrmex?.telemetry).toMatchObject({
      schemaVersion: 5,
      phase2: { schemaVersion: 2, samples: [{ tick: 100 }, { tick: 101 }] },
    });

    const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const reset = runTick({ game: game(102), memory: resetMemory });
    expect(reset.telemetry?.phase2.window.slice(0, 3)).toEqual([3, 100, 102]);
  });

  it("rejects oversized durable samples before traversal and counts the dropped window", () => {
    const oversized = new Array(65) as unknown[];
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error("oversized sample must not be read");
      },
    });
    const result = reducePhase2Telemetry({
      observation: observation(200),
      previous: {
        schemaVersion: 1,
        droppedSamples: Number.MAX_SAFE_INTEGER,
        samples: oversized,
      } as unknown as Phase2TelemetryState,
      maximumSamples: 64,
    });

    expect(result.telemetry.window.slice(0, 3)).toEqual([1, 200, 200]);
    expect(result.telemetry.window[10]).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("tracks one adjacent RCL duration across JSON reset without duplicate replay", () => {
    const colonyA = { colonyRef: "colony:0000000a", level: 2 } as const;
    const colonyB = { colonyRef: "colony:0000000b", level: 4 } as const;
    const baseline = reducePhase2Telemetry({
      observation: { ...observation(100), controllerLevels: [colonyB, colonyA] },
      previous: null,
    });
    const continued = reducePhase2Telemetry({
      observation: { ...observation(101), controllerLevels: [colonyA, colonyB] },
      previous: JSON.parse(JSON.stringify(baseline.state)) as Phase2TelemetryState,
    });
    const reset = reducePhase2Telemetry({
      observation: { ...observation(102), controllerLevels: [colonyB, colonyA] },
      previous: JSON.parse(JSON.stringify(continued.state)) as Phase2TelemetryState,
    });
    const completed = reducePhase2Telemetry({
      observation: {
        ...observation(103),
        controllerLevels: [{ ...colonyA, level: 3 }, colonyB],
      },
      previous: JSON.parse(JSON.stringify(reset.state)) as Phase2TelemetryState,
    });

    expect(PHASE2_RCL_DESTINATIONS).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(completed.state.rclTransitionDurations[1]).toEqual([1, 3, 3, 3, 3, 103]);
    expect(completed.state.rclTracks).toHaveLength(2);
    expect(completed.state.interruptedRclTracks).toBe(0);
    expect(completed.telemetry.progression.rcl).toEqual([3, 1, 3, 3, 3, 3, 103, 0, 0, 0]);

    const replay = reducePhase2Telemetry({
      observation: {
        ...observation(103),
        controllerLevels: [colonyB, { ...colonyA, level: 3 }],
      },
      previous: JSON.parse(JSON.stringify(completed.state)) as Phase2TelemetryState,
    });
    expect(replay.state).toEqual(completed.state);
    expect(replay.telemetry.progression.rcl).toEqual(completed.telemetry.progression.rcl);
  });

  it("breaks RCL timing continuity instead of fabricating transitions", () => {
    const colonyRef = "colony:0000000a";
    const state = reducePhase2Telemetry({
      observation: { ...observation(100), controllerLevels: [{ colonyRef, level: 2 }] },
      previous: null,
    }).state;

    const skipped = reducePhase2Telemetry({
      observation: { ...observation(102), controllerLevels: [{ colonyRef, level: 3 }] },
      previous: state,
    });
    expect(skipped.state.rclTransitionDurations[1]?.[0]).toBe(0);

    const downgraded = reducePhase2Telemetry({
      observation: { ...observation(103), controllerLevels: [{ colonyRef, level: 2 }] },
      previous: skipped.state,
    });
    const jumped = reducePhase2Telemetry({
      observation: { ...observation(104), controllerLevels: [{ colonyRef, level: 4 }] },
      previous: downgraded.state,
    });
    const missing = reducePhase2Telemetry({
      observation: { ...observation(105), controllerLevels: [] },
      previous: jumped.state,
    });
    const returned = reducePhase2Telemetry({
      observation: { ...observation(106), controllerLevels: [{ colonyRef, level: 5 }] },
      previous: missing.state,
    });

    expect(returned.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(true);
    expect(returned.state.interruptedRclTracks).toBe(4);
    expect(returned.telemetry.progression.rcl).toEqual([
      null,
      0,
      0,
      null,
      null,
      null,
      null,
      4,
      0,
      0,
    ]);
  });

  it("upgrades V1 state and rejects over-cap controller input before traversal", () => {
    const oversized = new Array(MAX_PHASE2_CONTROLLER_TRACKERS + 1) as unknown[];
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error("over-cap controller input must not be read");
      },
    });
    const result = reducePhase2Telemetry({
      observation: {
        ...observation(101),
        controllerLevels: oversized,
      } as unknown as Phase2TelemetryObservation,
      previous: {
        schemaVersion: 1,
        droppedSamples: 0,
        samples: [sample(100)],
      },
    });

    expect(result.state.schemaVersion).toBe(2);
    expect(result.state.samples.map(({ tick }) => tick)).toEqual([100, 101]);
    expect(result.state.rclTracks).toHaveLength(0);
    expect(result.state.droppedRclObservations).toBe(MAX_PHASE2_CONTROLLER_TRACKERS + 1);
  });

  it("drops malformed transition state without losing valid sample history", () => {
    const malformedTracks = new Array(MAX_PHASE2_CONTROLLER_TRACKERS + 1) as unknown[];
    Object.defineProperty(malformedTracks, 0, {
      get: () => {
        throw new Error("over-cap persisted tracks must not be read");
      },
    });
    const result = reducePhase2Telemetry({
      observation: observation(101),
      previous: {
        schemaVersion: 2,
        droppedSamples: 0,
        samples: [sample(100)],
        rclTimingSchemaVersion: 1,
        interruptedRclTracks: 0,
        droppedRclObservations: 0,
        droppedRclTransitions: 0,
        rclTracks: malformedTracks,
        rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map(() => [0, 0, null, null, null, null]),
      } as unknown as Phase2TelemetryState,
    });

    expect(result.state.samples.map(({ tick }) => tick)).toEqual([100, 101]);
    expect(result.state.rclTracks).toEqual([]);
    expect(result.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(true);

    const futureTiming = reducePhase2Telemetry({
      observation: {
        ...observation(102),
        controllerLevels: [{ colonyRef: "colony:0000000a", level: 2 }],
      },
      previous: {
        ...result.state,
        rclTimingSchemaVersion: 2,
        rclTracks: [["colony:0000000a", 1, 100, 101]],
      } as unknown as Phase2TelemetryState,
    });
    expect(futureTiming.state.samples.map(({ tick }) => tick)).toEqual([100, 101, 102]);
    expect(futureTiming.state.rclTracks).toEqual([["colony:0000000a", 2, 102, 102]]);
    expect(futureTiming.state.rclTransitionDurations.every(([count]) => count === 0)).toBe(true);
  });

  it("fails closed on malformed values instead of publishing misleading gate inputs", () => {
    expect(() =>
      reducePhase2Telemetry({
        observation: { ...observation(100), linkSent: -1 },
        previous: null,
      }),
    ).toThrow(/nonnegative safe integer/u);
    expect(() =>
      reducePhase2Telemetry({
        observation: observation(99),
        previous: {
          schemaVersion: 2,
          droppedSamples: 0,
          samples: [{ ...sample(100) }],
          rclTimingSchemaVersion: 1,
          interruptedRclTracks: 0,
          droppedRclObservations: 0,
          droppedRclTransitions: 0,
          rclTracks: [],
          rclTransitionDurations: PHASE2_RCL_DESTINATIONS.map(() => [0, 0, null, null, null, null]),
        },
      }),
    ).toThrow(/tick order/u);
  });
});

function observation(tick: number): Phase2TelemetryObservation {
  return {
    tick,
    controllerLevels: [],
    controllers: 2,
    rcl8Controllers: 1,
    sustainingColonies: 1,
    controllerProgress: 100,
    controllerProgressTotal: 1_000,
    minimumDowngradeTicks: 50_000,
    energyAvailable: 500,
    energyCapacity: 800,
    storedEnergy: 10_000,
    terminalEnergy: 2_000,
    reserveViolations: 1,
    colonyEnergyReserved: 400,
    colonyCpuReserved: 100,
    colonySpawnTicksReserved: 9,
    activeSpawns: 2,
    busySpawns: 1,
    scheduledSpawns: 1,
    deferredSpawns: 1,
    failedSpawns: 1,
    scheduledSpawnEnergy: 200,
    scheduledSpawnTicks: 9,
    constructionBacklog: 3,
    constructionProgressRemaining: 900,
    layoutComplete: 1,
    layoutDegraded: 1,
    layoutAccepted: 1,
    layoutDeferred: 2,
    layoutRejected: 1,
    layoutExecuted: 1,
    layoutFailed: 1,
    harvestedEnergy: 20,
    wastedEnergy: 2,
    sourceUptimeTicks: 1,
    sourceDowntimeTicks: 1,
    logisticsActiveFlows: 2,
    logisticsDeferredFlows: 1,
    logisticsRequested: 80,
    logisticsScheduled: 60,
    logisticsDelivered: 50,
    logisticsShortfall: 20,
    logisticsLoss: 3,
    linkAccepted: 1,
    linkDeferred: 2,
    linkFailed: 1,
    linkSent: 40,
    linkDelivered: 38,
    linkLost: 2,
    maintenanceAdmitted: 2,
    maintenanceDeferred: 1,
    maintenanceFailed: 1,
    maintenanceRequestedEnergy: 20,
    maintenanceFundedEnergy: 15,
    maintenanceEnergy: 15,
    industryAdmitted: 2,
    industryDeferred: 1,
    industryFailed: 1,
    industryReserved: 30,
    terminalTransactionEnergyPlanned: 4,
    labAdmitted: 1,
    labDeferred: 1,
    labFailed: 1,
    labOutput: 5,
    matureAdmitted: 1,
    matureDeferred: 1,
    matureFailed: 1,
    factoryOutput: 6,
    powerOutput: 7,
    observerAdmitted: 1,
    observerDeferred: 1,
    observerFailed: 1,
    measuredCpuMilli: 250,
    droppedInputs: 0,
  };
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

function sample(tick: number) {
  return {
    tick,
    harvestedEnergy: 0,
    logisticsDelivered: 0,
    linkDelivered: 0,
    industryOutput: 0,
    authorityFailures: 0,
    reserveViolations: 0,
    measuredCpuMilli: 0,
  };
}
