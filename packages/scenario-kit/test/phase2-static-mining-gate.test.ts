import { describe, expect, it } from "vitest";
import checkedEvidence from "../../../docs/phase2-mining-results.json";
import { collectStaticMiningEvidence } from "./fixtures/phase2-static-mining";

describe("Phase 2 static mining composed deterministic evidence (#46)", () => {
  it("matches checked evidence and maps every local acceptance outcome", () => {
    const actual = collectStaticMiningEvidence();

    expect(actual).toEqual(checkedEvidence);
    expect(actual.commitment).toEqual({
      fundedPrimaryCommitments: 2,
      noDuplicateDemandAfterReset: true,
      sourceIds: ["source-a", "source-b"],
      warmResetReorderedEquivalent: true,
    });
    expect(actual.deterministicScenario.singleAccessPosition).toEqual({
      roomName: "W1N1",
      x: 9,
      y: 10,
    });
    expect(actual.deterministicScenario.boundedProjectionEvaluations).toBe(2);
    expect(actual.deterministicScenario.boundedAdjacentCandidates).toBe(16);
    expect(actual.deterministicScenario.body).toEqual({
      usefulWorkParts: 5,
      harvestPerTick: 10,
      recoveryReservePreserved: true,
      throughputBounded: true,
    });
    expect(Object.values(actual.deterministicScenario.telemetry).every(Boolean)).toBe(true);
    expect(actual.deterministicScenario.outcomes).toHaveLength(16);
    expect(
      actual.deterministicScenario.outcomes.every(
        ({ activeCommitments, stableWorkPosition }) =>
          activeCommitments === 2 && stableWorkPosition,
      ),
    ).toBe(true);
    expect(actual.deterministicScenario.linkCommands).toBe(0);
    expect(actual.deterministicScenario.nonGoals).toEqual([
      "#47 hauling",
      "#48 link commands",
      "#49 repair",
    ]);
  });
});
