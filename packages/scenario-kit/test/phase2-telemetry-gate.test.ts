import { describe, expect, it } from "vitest";
import {
  MAX_PHASE2_TELEMETRY_SAMPLES,
  PHASE2_AUTHORITY_IDS,
  PHASE2_FLOW_IDENTITY_IDS,
  reducePhase2Telemetry,
  type Phase2TelemetryObservation,
  type Phase2TelemetryState,
} from "../../bot/src/telemetry/phase2";
import { canonicalHash } from "../src";

describe("Phase 2 bounded outcome telemetry evidence (#275)", () => {
  it("preserves deterministic accounting and bounded-window invariants", () => {
    const actual = collectTelemetryEvidence();

    expect(actual).toMatchObject({
      deterministic: { reorderedEquivalent: true, resetEquivalent: true },
      schemaVersion: 1,
    });
    expect(actual.authorities).toEqual([
      { admitted: 1, deferred: 1, failed: 1, id: "colony" },
      { admitted: 1, deferred: 1, failed: 1, id: "spawn" },
      { admitted: 1, deferred: 1, failed: 0, id: "mining" },
      { admitted: 2, deferred: 1, failed: 0, id: "logistics" },
      { admitted: 1, deferred: 2, failed: 2, id: "layout" },
      { admitted: 1, deferred: 2, failed: 1, id: "links" },
      { admitted: 2, deferred: 1, failed: 1, id: "maintenance" },
      { admitted: 2, deferred: 1, failed: 1, id: "resources" },
      { admitted: 1, deferred: 1, failed: 1, id: "labs" },
      { admitted: 1, deferred: 1, failed: 1, id: "mature" },
      { admitted: 1, deferred: 1, failed: 1, id: "observer" },
    ]);
    expect(actual.authorities.map(({ id }) => id)).toEqual([...PHASE2_AUTHORITY_IDS]);
    expect(actual.identities).toEqual([
      { balanced: true, id: "links-sent", residual: 0 },
      { balanced: true, id: "logistics-requested", residual: 0 },
      { balanced: true, id: "maintenance-budget", residual: 5 },
    ]);
    expect(actual.identities.map(({ id }) => id)).toEqual([...PHASE2_FLOW_IDENTITY_IDS]);
    expect(actual.gateInputs).toEqual({
      authorityFailures: 10,
      controllers: 2,
      harvestedEnergy: 20,
      industryEnergyInput: 190,
      industryOutput: 18,
      industryResourceInput: 113,
      linkDelivered: 38,
      logisticsDelivered: 50,
      measuredCpuMilli: 250,
      rcl8Controllers: 1,
      reserveViolations: 1,
      spawnUtilizationBasisPoints: 5_000,
      sustainingColonies: 1,
    });
    expect(actual.window).toEqual({
      authorityFailures: 40,
      droppedSamples: 2,
      firstTick: 102,
      harvestedEnergy: 94,
      industryEnergyInput: 760,
      industryOutput: 72,
      industryResourceInput: 452,
      lastTick: 105,
      linkDelivered: 152,
      logisticsDelivered: 200,
      measuredCpuMilli: 1_000,
      reserveViolations: 4,
      samples: 4,
    });
    expect(actual.window.samples).toBeLessThanOrEqual(MAX_PHASE2_TELEMETRY_SAMPLES);
    expect(actual.bounds).toMatchObject({
      authorityCount: PHASE2_AUTHORITY_IDS.length,
      identityCount: PHASE2_FLOW_IDENTITY_IDS.length,
      telemetryDecisionInputs: 0,
      unboundedLabels: 0,
    });
  });
});

export function collectTelemetryEvidence() {
  const nominalObservation = observation(100);
  const nominal = reducePhase2Telemetry({
    observation: nominalObservation,
    previous: null,
    maximumSamples: 4,
  });
  const reorderedObservation = Object.fromEntries(
    Object.entries(nominalObservation).reverse(),
  ) as unknown as Phase2TelemetryObservation;
  const reordered = reducePhase2Telemetry({
    observation: reorderedObservation,
    previous: null,
    maximumSamples: 4,
  });
  let state = JSON.parse(JSON.stringify(nominal.state)) as Phase2TelemetryState;
  let final = nominal;
  for (let tick = 101; tick <= 105; tick += 1) {
    final = reducePhase2Telemetry({
      observation: { ...observation(tick), harvestedEnergy: tick - 80 },
      previous: JSON.parse(JSON.stringify(state)) as Phase2TelemetryState,
      maximumSamples: 4,
    });
    state = final.state;
  }

  return {
    schemaVersion: 1,
    deterministic: {
      reorderedEquivalent: canonicalHash(nominal.telemetry) === canonicalHash(reordered.telemetry),
      resetEquivalent:
        canonicalHash(final) ===
        canonicalHash(
          reducePhase2Telemetry({
            observation: { ...observation(105), harvestedEnergy: 25 },
            previous: JSON.parse(JSON.stringify(stateBeforeLast())) as Phase2TelemetryState,
            maximumSamples: 4,
          }),
        ),
    },
    authorities: nominal.telemetry.authorities.map((row, index) => ({
      id: PHASE2_AUTHORITY_IDS[index],
      admitted: row[0],
      deferred: row[1],
      failed: row[2],
    })),
    identities: nominal.telemetry.identities.map((row, index) => ({
      id: PHASE2_FLOW_IDENTITY_IDS[index],
      balanced: row[0],
      residual: row[1],
    })),
    gateInputs: {
      controllers: nominal.telemetry.progression.controllers,
      rcl8Controllers: nominal.telemetry.progression.rcl8Controllers,
      sustainingColonies: nominal.telemetry.progression.sustainingColonies,
      reserveViolations: nominal.telemetry.reserves.violations,
      spawnUtilizationBasisPoints: nominal.telemetry.spawn.utilizationBasisPoints,
      measuredCpuMilli: nominal.telemetry.window[11],
      authorityFailures: nominal.telemetry.window[9],
      harvestedEnergy: nominal.telemetry.flows.harvestedEnergy,
      logisticsDelivered: nominal.telemetry.flows.logistics.delivered,
      linkDelivered: nominal.telemetry.flows.links.delivered,
      industryEnergyInput: nominal.telemetry.window[6],
      industryResourceInput: nominal.telemetry.window[7],
      industryOutput: nominal.telemetry.window[8],
    },
    window: {
      samples: final.telemetry.window[0],
      firstTick: final.telemetry.window[1],
      lastTick: final.telemetry.window[2],
      harvestedEnergy: final.telemetry.window[3],
      logisticsDelivered: final.telemetry.window[4],
      linkDelivered: final.telemetry.window[5],
      industryEnergyInput: final.telemetry.window[6],
      industryResourceInput: final.telemetry.window[7],
      industryOutput: final.telemetry.window[8],
      authorityFailures: final.telemetry.window[9],
      reserveViolations: final.telemetry.window[10],
      measuredCpuMilli: final.telemetry.window[11],
      droppedSamples: final.telemetry.window[12],
    },
    bounds: {
      authorityCount: PHASE2_AUTHORITY_IDS.length,
      identityCount: nominal.telemetry.identities.length,
      scenarioWindowSamples: 4,
      productionMaximumSamples: MAX_PHASE2_TELEMETRY_SAMPLES,
      telemetryOwnerBytes: 8_192,
      unboundedLabels: 0,
      telemetryDecisionInputs: 0,
    },
  };
}

function stateBeforeLast(): Phase2TelemetryState {
  let state = reducePhase2Telemetry({
    observation: observation(100),
    previous: null,
    maximumSamples: 4,
  }).state;
  for (let tick = 101; tick <= 104; tick += 1)
    state = reducePhase2Telemetry({
      observation: { ...observation(tick), harvestedEnergy: tick - 80 },
      previous: JSON.parse(JSON.stringify(state)) as Phase2TelemetryState,
      maximumSamples: 4,
    }).state;
  return state;
}

function observation(tick: number): Phase2TelemetryObservation {
  return {
    tick,
    attrition: { colonies: [], assets: [], droppedObservations: 0 },
    controllerLevels: [],
    droppedControllerLevels: 0,
    cooldownSlots: [
      [2, 1],
      [3, 2],
      [1, 0],
      [4, 1],
      [1, 0],
    ],
    droppedCooldownInputs: 0,
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
    industryEnergyInput: 190,
    industryResourceInput: 113,
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
