import { describe, expect, it } from "vitest";
import checkedEvidence from "../../../docs/phase2-layout-migration-results.json";
import { collectPhase2LayoutMigrationEvidence } from "./fixtures/phase2-layout-migration";

describe("Phase 2 stable layout migration evidence (#365)", () => {
  it("matches checked evidence and reaches stable committed extension geometry within bounds", () => {
    const actual = collectPhase2LayoutMigrationEvidence();

    expect(actual).toEqual(checkedEvidence);
    expect(actual).toMatchObject({ schemaVersion: 1, issue: 365, status: "complete" });
    expect(actual.scenario).toMatchObject({
      id: "phase2-layout-extension-migration-v1",
      seed: "phase2-layout-extension-migration-seed-v1",
      ticks: 70,
      variants: {
        warm: { resetTicks: [], reverseObservation: false },
        reset: { resetTicks: [50_015], reverseObservation: false },
        reordered: { resetTicks: [], reverseObservation: true },
      },
      facts: {
        roomName: "W1N1",
        spawn: { id: "spawn-1", name: "Spawn1", pos: { x: 5, y: 25 } },
        controller: { id: "controller-1", pos: { x: 25, y: 25 } },
        sources: [
          { id: "source-1", pos: { x: 8, y: 10 } },
          { id: "source-2", pos: { x: 30, y: 10 } },
        ],
      },
      commands: [
        { kind: "create-site", structureType: "extension" },
        { kind: "destroy-structure", structureType: "extension" },
        { kind: "create-site", structureType: "extension" },
      ],
      final: {
        activeSites: 0,
        exactExtensions: 10,
        removalProposals: 0,
        siteProposals: 0,
      },
    });
    expect(actual.scenario.milestones).toEqual({
      destroyCommandAt: 50_031,
      destroyDisappearanceObservedAt: 50_032,
      firstBuildCompletedAt: 50_030,
      firstCompletedReplacementObservedAt: 50_031,
      firstSiteCommandAt: 50_000,
      firstSiteObservedAt: 50_001,
      secondBuildCompletedAt: 50_062,
      secondCompletedReplacementObservedAt: 50_063,
      secondSiteCommandAt: 50_032,
      secondSiteObservedAt: 50_033,
    });
    expect(actual.scenario.commands[1]?.tick).toBeGreaterThanOrEqual(
      actual.scenario.milestones.firstCompletedReplacementObservedAt,
    );
    expect(actual.scenario.deferredEffects).toEqual({
      firstSiteObservedNextTick: true,
      firstReplacementObservedNextTick: true,
      destroyDisappearanceObservedNextTick: true,
      secondSiteObservedNextTick: true,
      secondReplacementObservedNextTick: true,
    });
    expect(actual.budgets).toEqual({
      constructionEnergy: 6_000,
      maximumActiveSites: 1,
      maximumCpuPerTick: 0.25,
      maximumEnergyPerTick: 100,
      persistentSchemaVersion: 19,
    });
    expect(actual.safety.minimumActiveExtensions).toBeGreaterThanOrEqual(9);
    expect(actual.safety).toMatchObject({
      accessWitnessPreserved: true,
      accessWitnessScope: "scenario-level",
      duplicateDestroyCommands: 0,
    });
    expect(actual.equivalence.semanticBytesIdentical).toBe(true);
    expect(new Set(Object.values(actual.equivalence.outcomeHashes))).toHaveLength(1);
  });
});
