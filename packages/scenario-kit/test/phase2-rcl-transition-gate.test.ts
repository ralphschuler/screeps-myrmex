import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import checked from "../../../docs/phase2-rcl-transition-results.json";
import { utf8ByteLength } from "../../bot/src/config/canonical";
import { runTick } from "../../bot/src/runtime/tick";
import { establishedRcl2World } from "../../bot/test/support/established-rcl2-fixture";
import {
  MAX_PHASE2_CONTROLLER_TRACKERS,
  PHASE2_RCL_DESTINATIONS,
  reducePhase2Telemetry,
  type Phase2ControllerObservation,
  type Phase2TelemetryObservation,
  type Phase2TelemetryState,
} from "../../bot/src/telemetry/phase2";
import { canonicalHash, canonicalSerialize } from "../src";

describe("Phase 2 bounded RCL transition timing evidence (#277)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", 101);
    vi.stubGlobal("FIND_SOURCES", 105);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", 106);
    vi.stubGlobal("FIND_STRUCTURES", 107);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", 111);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("matches checked reset, interruption, persistence, and replay evidence", () => {
    expect(collectRclTransitionEvidence()).toEqual(checked);
  });
});

export function collectRclTransitionEvidence() {
  const persistence = collectPersistenceEvidence();
  const forward = runSequence(false, true);
  const warm = runSequence(false, false);
  const reversed = runSequence(true, true);
  const replay = reducePhase2Telemetry({
    observation: observation(103, [
      controller("colony:0000000b", 5),
      controller("colony:0000000a", 3),
    ]),
    previous: JSON.parse(JSON.stringify(forward.final)) as Phase2TelemetryState,
  });
  const v1Upgrade = reducePhase2Telemetry({
    observation: observation(100, [controller("colony:0000000a", 2)]),
    previous: { schemaVersion: 1, droppedSamples: 0, samples: [] },
  });

  return {
    schemaVersion: 1,
    deterministic: {
      reorderedEquivalent: canonicalHash(forward.final) === canonicalHash(reversed.final),
      resetEquivalent: canonicalHash(forward.final) === canonicalHash(warm.final),
      sameTickReplayEquivalent: canonicalHash(replay.state) === canonicalHash(forward.final),
    },
    transition: {
      destinationRcl: 3,
      row: forward.final.rclTransitionDurations[1],
      completedTransitions: forward.final.rclTransitionDurations.reduce(
        (sum, [samples]) => sum + samples,
        0,
      ),
      activeTracks: forward.final.rclTracks.length,
      interruptedTracks: forward.final.interruptedRclTracks,
      droppedObservations: forward.final.droppedRclObservations,
      droppedTransitions: forward.final.droppedRclTransitions,
    },
    migration: {
      fromSchemaVersion: 1,
      toSchemaVersion: v1Upgrade.state.schemaVersion,
      baselineOnly: v1Upgrade.state.rclTracks.length === 1,
    },
    persistence,
    bounds: {
      destinationRows: PHASE2_RCL_DESTINATIONS.length,
      maximumControllerTracks: MAX_PHASE2_CONTROLLER_TRACKERS,
      telemetryOwnerMaximumBytes: 8_192,
    },
  };
}

function collectPersistenceEvidence() {
  const world = establishedRcl2World();
  let memory = {} as Memory;
  runTick({ game: world.game(100), memory });
  memory = JSON.parse(JSON.stringify(memory)) as Memory;
  runTick({ game: world.game(101), memory });
  const completionGame = world.game(102);
  const controller = completionGame.rooms.W1N1?.controller as unknown as
    { level: number; progress: number; progressTotal: number } | undefined;
  if (controller === undefined) throw new Error("expected owned controller fixture");
  controller.level = 3;
  controller.progress = 0;
  controller.progressTotal = 135_000;
  const completed = runTick({ game: completionGame, memory });
  const completedOwner = phase2Owner(memory);
  const completedRcl = completedOwner.rcl;
  const completedDurations = completedRcl[5];

  memory = JSON.parse(JSON.stringify(memory)) as Memory;
  const replayed = runTick({ game: world.game(103), memory });
  if (completed.telemetry === null || replayed.telemetry === null)
    throw new Error("expected runtime telemetry");
  const replayedTelemetryOwner = telemetryOwner(memory);
  const replayedOwner = phase2Owner(memory);
  const replayedDurations = replayedOwner.rcl[5];
  const encoded = canonicalSerialize(replayedTelemetryOwner);
  return {
    ownerSchemaVersion: replayedOwner.schemaVersion,
    timingSchemaVersion: replayedOwner.rcl[0],
    completedSamples: completedDurations[0]?.[1] ?? 0,
    replayedSamples: replayedDurations[0]?.[1] ?? 0,
    compactOwnerRoundTrip: completedDurations[0]?.[1] === 1 && replayedDurations[0]?.[1] === 1,
    resetOutputEquivalent:
      canonicalHash(completed.telemetry.phase2.progression.rcl) ===
      canonicalHash(replayed.telemetry.phase2.progression.rcl),
    roomNamesRedacted: !encoded.includes("W1N1"),
    ownerBytes: utf8ByteLength(encoded),
  };
}

type PersistedPhase2Owner = {
  readonly schemaVersion: number;
  readonly rcl: readonly [
    timingSchemaVersion: number,
    interrupted: number,
    droppedObservations: number,
    droppedTransitions: number,
    tracks: readonly unknown[],
    durations: readonly (readonly number[])[],
  ];
};

function telemetryOwner(memory: Memory): Record<string, unknown> {
  const owner = memory.myrmex?.telemetry;
  if (owner === undefined) throw new Error("expected telemetry owner");
  return owner;
}

function phase2Owner(memory: Memory): PersistedPhase2Owner {
  const phase2 = telemetryOwner(memory).phase2;
  if (typeof phase2 !== "object" || phase2 === null || Array.isArray(phase2))
    throw new Error("expected Phase 2 telemetry owner");
  return phase2 as unknown as PersistedPhase2Owner;
}

function runSequence(
  reverse: boolean,
  reconstructEachTick: boolean,
): {
  readonly final: Phase2TelemetryState;
} {
  const ordered = (controllers: readonly Phase2ControllerObservation[]) =>
    reverse ? [...controllers].reverse() : controllers;
  let state = reducePhase2Telemetry({
    observation: observation(
      100,
      ordered([controller("colony:0000000a", 2), controller("colony:0000000b", 4)]),
    ),
    previous: null,
  }).state;
  const previous = () =>
    reconstructEachTick ? (JSON.parse(JSON.stringify(state)) as Phase2TelemetryState) : state;
  state = reducePhase2Telemetry({
    observation: observation(
      101,
      ordered([controller("colony:0000000a", 2), controller("colony:0000000b", 4)]),
    ),
    previous: previous(),
  }).state;
  state = reducePhase2Telemetry({
    observation: observation(102, ordered([controller("colony:0000000a", 3)])),
    previous: previous(),
  }).state;
  const final = reducePhase2Telemetry({
    observation: observation(
      103,
      ordered([controller("colony:0000000a", 3), controller("colony:0000000b", 5)]),
    ),
    previous: previous(),
  }).state;
  return { final };
}

function controller(colonyRef: string, level: number): Phase2ControllerObservation {
  return { colonyRef, level };
}

function observation(
  tick: number,
  controllerLevels: readonly Phase2ControllerObservation[],
): Phase2TelemetryObservation {
  return {
    tick,
    controllerLevels,
    droppedControllerLevels: 0,
    controllers: controllerLevels.length,
    rcl8Controllers: controllerLevels.filter(({ level }) => level === 8).length,
    sustainingColonies: 0,
    controllerProgress: 0,
    controllerProgressTotal: 0,
    minimumDowngradeTicks: null,
    energyAvailable: 0,
    energyCapacity: 0,
    storedEnergy: 0,
    terminalEnergy: 0,
    reserveViolations: 0,
    colonyEnergyReserved: 0,
    colonyCpuReserved: 0,
    colonySpawnTicksReserved: 0,
    activeSpawns: 0,
    busySpawns: 0,
    scheduledSpawns: 0,
    deferredSpawns: 0,
    failedSpawns: 0,
    scheduledSpawnEnergy: 0,
    scheduledSpawnTicks: 0,
    constructionBacklog: 0,
    constructionProgressRemaining: 0,
    layoutComplete: 0,
    layoutDegraded: 0,
    layoutAccepted: 0,
    layoutDeferred: 0,
    layoutRejected: 0,
    layoutExecuted: 0,
    layoutFailed: 0,
    harvestedEnergy: 0,
    wastedEnergy: 0,
    sourceUptimeTicks: 0,
    sourceDowntimeTicks: 0,
    logisticsActiveFlows: 0,
    logisticsDeferredFlows: 0,
    logisticsRequested: 0,
    logisticsScheduled: 0,
    logisticsDelivered: 0,
    logisticsShortfall: 0,
    logisticsLoss: 0,
    linkAccepted: 0,
    linkDeferred: 0,
    linkFailed: 0,
    linkSent: 0,
    linkDelivered: 0,
    linkLost: 0,
    maintenanceAdmitted: 0,
    maintenanceDeferred: 0,
    maintenanceFailed: 0,
    maintenanceRequestedEnergy: 0,
    maintenanceFundedEnergy: 0,
    maintenanceEnergy: 0,
    industryAdmitted: 0,
    industryDeferred: 0,
    industryFailed: 0,
    industryReserved: 0,
    terminalTransactionEnergyPlanned: 0,
    labAdmitted: 0,
    labDeferred: 0,
    labFailed: 0,
    labOutput: 0,
    matureAdmitted: 0,
    matureDeferred: 0,
    matureFailed: 0,
    factoryOutput: 0,
    powerOutput: 0,
    observerAdmitted: 0,
    observerDeferred: 0,
    observerFailed: 0,
    measuredCpuMilli: 0,
    droppedInputs: 0,
  };
}
