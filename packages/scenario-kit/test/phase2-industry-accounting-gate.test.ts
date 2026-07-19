import { describe, expect, it } from "vitest";
import checked from "../../../docs/phase2-industry-accounting-results.json";
import {
  projectLabTelemetry,
  projectMatureCommandTelemetry,
  type LabAttemptSettlement,
  type LabCompositionProjection,
  type MatureAttemptSettlement,
} from "../../bot/src/industry";
import {
  emptyPhase2TelemetryObservation,
  MAX_PHASE2_TELEMETRY_SAMPLES,
  reducePhase2Telemetry,
  type Phase2TelemetryState,
} from "../../bot/src/telemetry/phase2";
import { canonicalHash } from "../src";

describe("Phase 2 exact settled industry accounting evidence (#53)", () => {
  it("matches fixed lab, factory, power, migration, and window outcomes", () => {
    expect(collectPhase2IndustryAccountingEvidence()).toEqual(checked);
  });
});

export function collectPhase2IndustryAccountingEvidence() {
  const labs = projectLabTelemetry(labProjection(), []);
  const mature = projectMatureCommandTelemetry({
    execution: [],
    intents: [],
    settlements: [
      matureSettlement("factory", "settled", 40, 100, 20),
      matureSettlement("power-processing", "settled", 150, 3, 3),
      matureSettlement("factory", "cancelled", 999, 999, 999),
    ],
  });
  const labAccounting = required(labs.accounting);
  const matureAccounting = required(mature.accounting);
  const observation = {
    ...emptyPhase2TelemetryObservation(100),
    industryEnergyInput:
      labAccounting[0] + matureAccounting.factory[0] + matureAccounting.powerProcessing[0],
    industryResourceInput:
      labAccounting[1] + matureAccounting.factory[1] + matureAccounting.powerProcessing[1],
    labOutput: labAccounting[2],
    factoryOutput: matureAccounting.factory[2],
    powerOutput: matureAccounting.powerProcessing[2],
  };
  const nominal = reducePhase2Telemetry({ observation, previous: null });
  const reordered = reducePhase2Telemetry({
    observation: Object.fromEntries(Object.entries(observation).reverse()) as typeof observation,
    previous: null,
  });
  const reset = reducePhase2Telemetry({
    observation: { ...observation, tick: 101 },
    previous: JSON.parse(JSON.stringify(nominal.state)) as Phase2TelemetryState,
  });
  const legacy = {
    ...nominal.state,
    schemaVersion: 3,
    samples: nominal.state.samples.map((sample) => {
      const legacySample = { ...sample } as Record<string, unknown>;
      delete legacySample.industryEnergyInput;
      delete legacySample.industryResourceInput;
      return legacySample;
    }),
  } as unknown as Phase2TelemetryState;
  const migrated = reducePhase2Telemetry({
    observation: { ...observation, tick: 101 },
    previous: JSON.parse(JSON.stringify(legacy)) as Phase2TelemetryState,
  });

  return {
    schemaVersion: 1,
    deterministic: {
      reorderedEquivalent: canonicalHash(nominal.telemetry) === canonicalHash(reordered.telemetry),
      resetEquivalent:
        canonicalHash(reset) ===
        canonicalHash(
          reducePhase2Telemetry({
            observation: { ...observation, tick: 101 },
            previous: nominal.state,
          }),
        ),
    },
    settlements: {
      labs: labAccounting,
      factory: matureAccounting.factory,
      powerProcessing: matureAccounting.powerProcessing,
      nonSettledInputIncluded: labAccounting[0] - 20 + matureAccounting.factory[0] - 40,
      labObjectiveAmount: labs.settledAmount,
    },
    phase2: {
      energyInput: nominal.telemetry.window[6],
      resourceInput: nominal.telemetry.window[7],
      resourceOutput: nominal.telemetry.window[8],
      window: nominal.telemetry.window,
    },
    migration: {
      fromSchemaVersion: 3,
      toSchemaVersion: migrated.state.schemaVersion,
      legacySamplesDropped: migrated.state.droppedSamples,
      currentSamples: migrated.state.samples.length,
    },
    bounds: {
      productionMaximumSamples: MAX_PHASE2_TELEMETRY_SAMPLES,
      telemetryOwnerBytes: 8_192,
      dynamicResourceLabels: 0,
      telemetryDecisionInputs: 0,
    },
  };
}

function labProjection(): LabCompositionProjection {
  return {
    assignments: [],
    creepFingerprints: new Map(),
    intents: [],
    migrationRooms: [],
    objectiveBudgets: [],
    policy: { blockers: [], budgets: [], commitments: [], demands: [], dispositions: [] },
    resourceDemands: { blockers: [], dispositions: [], edges: [], endpoints: [], nodes: [] },
    settlements: [
      labSettlement("reaction", "settled", 5, 0, 10, 5),
      labSettlement("reverse-reaction", "settled", 5, 0, 5, 10),
      labSettlement("boost", "settled", 1, 20, 30, 0),
      labSettlement("reaction", "retry", 0, 999, 999, 999),
    ],
  };
}

function labSettlement(
  kind: LabAttemptSettlement["kind"],
  status: LabAttemptSettlement["status"],
  settledAmount: number,
  energyInput: number,
  resourceInput: number,
  resourceOutput: number,
): LabAttemptSettlement {
  return {
    accounting: { energyInput, resourceInput, resourceOutput },
    attemptId: `${kind}/${status}`,
    kind,
    objectiveId: `${kind}/objective`,
    objectiveRevision: 1,
    reason: status === "settled" ? "exact-effect" : "no-effect",
    retry: status === "retry" ? 1 : 0,
    settledAmount,
    status,
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected accounting evidence");
  return value;
}

function matureSettlement(
  kind: MatureAttemptSettlement["kind"],
  status: MatureAttemptSettlement["status"],
  energyInput: number,
  resourceInput: number,
  resourceOutput: number,
): MatureAttemptSettlement {
  return {
    accounting: { energyInput, resourceInput, resourceOutput },
    attemptId: `${kind}/${status}`,
    kind,
    objectiveId: `${kind}/objective`,
    objectiveRevision: 1,
    reason: status === "settled" ? "exact-effect" : "conflicting-effect",
    retry: 0,
    settledAmount: resourceOutput,
    status,
  };
}
