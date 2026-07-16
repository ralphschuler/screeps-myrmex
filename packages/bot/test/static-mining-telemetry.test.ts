import { describe, expect, it } from "vitest";
import {
  MAX_STATIC_MINING_TELEMETRY_SOURCES,
  reduceStaticMiningTelemetry,
  type StaticMiningSourceObservation,
} from "../src/telemetry";

describe("static mining telemetry reducer", () => {
  it("observes uptime, extraction, idle and replacement gaps, container condition, and CPU", () => {
    const initial = reduceStaticMiningTelemetry({
      tick: 100,
      cpuUsed: 0.2,
      observations: [source("b", 3_000, "missing"), source("a", 2_000, "active")],
    });
    expect(initial.telemetry).toMatchObject({
      observedSources: 2,
      sourceUptimeTicks: 1,
      harvestedEnergy: 0,
      replacementGapTicks: 1,
      cpuPerHarvestedEnergy: null,
    });

    const next = reduceStaticMiningTelemetry({
      tick: 101,
      cpuUsed: 0.25,
      previous: initial.state,
      observations: [
        source("a", 1_990, "idle", { capacity: 2_000, used: 1_500, ticksToDecay: 80 }),
        source("b", 2_995, "replacement-pending"),
      ],
    });
    expect(next.telemetry).toMatchObject({
      harvestedEnergy: 15,
      wastedEnergy: 0,
      minerIdleTicks: 1,
      replacementGapTicks: 1,
      cpuPerHarvestedEnergy: 0.25 / 15,
    });
    expect(next.telemetry.sources[0]).toMatchObject({
      sourceId: "a",
      containerFillBasisPoints: 7_500,
      containerTicksToDecay: 80,
    });
  });

  it("accounts unharvested energy as waste across source regeneration", () => {
    const previous = reduceStaticMiningTelemetry({
      tick: 200,
      cpuUsed: 0,
      observations: [{ ...source("a", 400, "active"), ticksToRegeneration: 1 }],
    });
    const regenerated = reduceStaticMiningTelemetry({
      tick: 201,
      cpuUsed: 0.1,
      previous: previous.state,
      observations: [{ ...source("a", 2_990, "active"), ticksToRegeneration: 300 }],
    });
    expect(regenerated.telemetry).toMatchObject({
      harvestedEnergy: 10,
      wastedEnergy: 400,
      cpuPerHarvestedEnergy: 0.01,
    });
  });

  it("canonicalizes reorder and duplicates before enforcing the hard source bound", () => {
    const observations = Array.from(
      { length: MAX_STATIC_MINING_TELEMETRY_SOURCES + 2 },
      (_, index) => source(`source-${String(index).padStart(3, "0")}`, 3_000, "active"),
    );
    const first = observations[0];
    const second = observations[1];
    if (first === undefined || second === undefined) throw new Error("expected telemetry fixtures");
    const left = reduceStaticMiningTelemetry({
      tick: 300,
      cpuUsed: 0,
      maximumSources: 2,
      observations: [second, first, first, ...observations.slice(2)],
    });
    const right = reduceStaticMiningTelemetry({
      tick: 300,
      cpuUsed: 0,
      maximumSources: 2,
      observations: [...observations].reverse(),
    });
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(left.telemetry.sources.map(({ sourceId }) => sourceId)).toEqual([
      "source-000",
      "source-001",
    ]);
    expect(left.telemetry).toMatchObject({ observedSources: 2, droppedSources: 64 });
    expect(Object.isFrozen(left.telemetry.sources)).toBe(true);
  });

  it("rejects malformed numeric inputs instead of publishing misleading evidence", () => {
    expect(() =>
      reduceStaticMiningTelemetry({
        tick: 1,
        cpuUsed: Number.NaN,
        observations: [source("a", 3_000, "active")],
      }),
    ).toThrow(/CPU/u);
    expect(() =>
      reduceStaticMiningTelemetry({
        tick: -1,
        cpuUsed: 0,
        observations: [],
      }),
    ).toThrow(/safe integer/u);
  });
});

function source(
  sourceId: string,
  energy: number,
  minerState: StaticMiningSourceObservation["minerState"],
  container: StaticMiningSourceObservation["container"] = null,
): StaticMiningSourceObservation {
  return {
    sourceId,
    energy,
    energyCapacity: 3_000,
    ticksToRegeneration: 50,
    minerState,
    container,
  };
}
