import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTick } from "../src/runtime/tick";
import { establishedRcl2World } from "./support/established-rcl2-fixture";
import {
  PHASE2_AUTHORITY_IDS,
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
    const forward = runTick({
      game: establishedRcl2World().game(100),
      memory: {} as Memory,
    });
    const reversed = runTick({
      game: establishedRcl2World({ reverseCollections: true }).game(100),
      memory: {} as Memory,
    });

    expect(forward.telemetry?.phase2).toEqual(reversed.telemetry?.phase2);
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
      phase2: { schemaVersion: 1, samples: [{ tick: 100 }, { tick: 101 }] },
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
          schemaVersion: 1,
          droppedSamples: 0,
          samples: [{ ...sample(100) }],
        },
      }),
    ).toThrow(/tick order/u);
  });
});

function observation(tick: number): Phase2TelemetryObservation {
  return {
    tick,
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
