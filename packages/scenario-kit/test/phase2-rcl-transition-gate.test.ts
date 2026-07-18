import { describe, expect, it } from "vitest";
import checked from "../../../docs/phase2-rcl-transition-results.json";
import {
  MAX_PHASE2_CONTROLLER_TRACKERS,
  PHASE2_RCL_DESTINATIONS,
  reducePhase2Telemetry,
  type Phase2ControllerObservation,
  type Phase2TelemetryObservation,
  type Phase2TelemetryState,
} from "../../bot/src/telemetry/phase2";
import { canonicalHash } from "../src";

describe("Phase 2 bounded RCL transition timing evidence (#277)", () => {
  it("matches checked reset, interruption, and replay evidence", () => {
    expect(collectRclTransitionEvidence()).toEqual(checked);
  });
});

export function collectRclTransitionEvidence() {
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
    bounds: {
      destinationRows: PHASE2_RCL_DESTINATIONS.length,
      maximumControllerTracks: MAX_PHASE2_CONTROLLER_TRACKERS,
      persistedRoomNames: 0,
      telemetryOwnerBytes: 8_192,
      telemetryDecisionInputs: 0,
    },
  };
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
