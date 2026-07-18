import { describe, expect, it } from "vitest";
import checked from "../../../docs/phase2-cooldown-utilization-results.json";
import {
  emptyPhase2TelemetryObservation,
  MAX_PHASE2_TELEMETRY_SAMPLES,
  PHASE2_COOLDOWN_IDS,
  PHASE2_COOLDOWN_LIMITS,
  reducePhase2Telemetry,
  type Phase2CooldownObservation,
  type Phase2TelemetryState,
} from "../../bot/src/telemetry/phase2";
import { canonicalHash } from "../src";

describe("Phase 2 bounded cooldown-utilization evidence (#53)", () => {
  it("matches fixed reset, reorder, continuity, migration, and bound evidence", () => {
    expect(collectCooldownUtilizationEvidence()).toEqual(checked);
  });
});

export function collectCooldownUtilizationEvidence() {
  const firstObservation = observation(100, [
    [2, 1],
    [3, 2],
    [0, 0],
    [4, 1],
    [1, 0],
  ]);
  const secondObservation = observation(101, [
    [2, 0],
    [3, 1],
    [1, 1],
    [4, 2],
    [1, 1],
  ]);
  const first = reducePhase2Telemetry({ observation: firstObservation, previous: null });
  const reordered = reducePhase2Telemetry({
    observation: Object.fromEntries(Object.entries(firstObservation).reverse()) as ReturnType<
      typeof observation
    >,
    previous: null,
  });
  const reset = reducePhase2Telemetry({
    observation: secondObservation,
    previous: JSON.parse(JSON.stringify(first.state)) as Phase2TelemetryState,
  });
  const warm = reducePhase2Telemetry({ observation: secondObservation, previous: first.state });
  const replay = reducePhase2Telemetry({ observation: secondObservation, previous: reset.state });
  const gap = reducePhase2Telemetry({
    observation: observation(
      103,
      PHASE2_COOLDOWN_IDS.map(() => [0, 0] as const),
    ),
    previous: reset.state,
  });
  const legacy = {
    ...reset.state,
    schemaVersion: 4,
    samples: reset.state.samples.map((sample) => {
      const row = { ...sample } as Record<string, unknown>;
      delete row.cooldownSlots;
      return row;
    }),
  } as unknown as Phase2TelemetryState;
  const migrated = reducePhase2Telemetry({
    observation: observation(
      102,
      PHASE2_COOLDOWN_IDS.map(() => [0, 0] as const),
    ),
    previous: JSON.parse(JSON.stringify(legacy)) as Phase2TelemetryState,
  });
  const resetCooldowns = required(reset.telemetry.cooldowns);
  const gapCooldowns = required(gap.telemetry.cooldowns);

  return {
    schemaVersion: 1,
    deterministic: {
      reorderedEquivalent: canonicalHash(first.telemetry) === canonicalHash(reordered.telemetry),
      resetEquivalent: canonicalHash(reset) === canonicalHash(warm),
      sameTickReplayEquivalent: canonicalHash(replay) === canonicalHash(reset),
    },
    rows: PHASE2_COOLDOWN_IDS.map((id, index) => ({
      id,
      current: resetCooldowns.current[index],
      window: resetCooldowns.window[index],
    })),
    continuity: {
      consecutive: resetCooldowns.continuous,
      gap: gapCooldowns.continuous,
      gapSamples: gap.telemetry.window[0],
      gapFirstTick: gap.telemetry.window[1],
      gapLastTick: gap.telemetry.window[2],
    },
    migration: {
      fromSchemaVersion: 4,
      toSchemaVersion: migrated.state.schemaVersion,
      unknowableSamplesDropped: migrated.state.droppedSamples,
      currentSamples: migrated.state.samples.length,
    },
    bounds: {
      ids: PHASE2_COOLDOWN_IDS,
      perKindCandidates: PHASE2_COOLDOWN_LIMITS,
      productionMaximumSamples: MAX_PHASE2_TELEMETRY_SAMPLES,
      telemetryOwnerBytes: 8_192,
      dynamicLabels: 0,
      telemetryDecisionInputs: 0,
    },
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected cooldown evidence");
  return value;
}

function observation(tick: number, cooldownSlots: readonly Phase2CooldownObservation[]) {
  return {
    ...emptyPhase2TelemetryObservation(tick),
    cooldownSlots,
  };
}
