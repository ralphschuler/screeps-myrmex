import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import checkedEvidence from "../../../docs/phase2-layout-migration-results.json";
import { collectPhase2LayoutMigrationEvidence } from "./fixtures/phase2-layout-migration";

const FIND_CREEPS_VALUE = 101;
const FIND_HOSTILE_CREEPS_VALUE = 102;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("Phase 2 stable layout migration evidence (#365/#377/#383/#441/#451/#453/#457)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_HOSTILE_CREEPS", FIND_HOSTILE_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", FIND_DROPPED_RESOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());
  it("matches checked evidence and reaches stable current geometry within bounds", async () => {
    const actual = await collectPhase2LayoutMigrationEvidence();

    expect(actual).toEqual(checkedEvidence);
    expect(actual).toMatchObject({
      activeStaleExtensionConvergence: actual.activeStaleExtensionConvergence,
      activeStaleTowerConvergence: actual.activeStaleTowerConvergence,
      evidenceIssues: [365, 377, 383, 441, 451, 453, 457],
      issue: 365,
      productionBuild: {
        buildEnergy: 100,
        completedStructureType: "extension",
        directProgressMutation: false,
        semanticBytesIdentical: true,
        siteObservedAbsentAfterCompletion: true,
      },
      schemaVersion: 6,
      status: "complete",
    });
    expect(actual.activeStaleTowerConvergence).toMatchObject({
      authority: {
        budgetAndFlowFunded: true,
        destructionObservedNextTick: true,
        exactDeliveryObserved: true,
        flowRetiredBeforeSettlement: true,
        handoffAfterSettlement: true,
        handoffCommandFree: true,
        settlementCommandFree: true,
        siteObservedNextTick: true,
      },
      budgets: {
        evacuationEnergy: 500,
        maximumActiveSites: 1,
        modeledConstructionEnergy: 5_000,
        modeledConstructionEnergyPerTick: 100,
      },
      equivalence: { semanticBytesIdentical: true },
      final: {
        exactTowers: 2,
        removalProposals: 0,
        siteCount: 0,
        siteProposals: 0,
        staleRecords: 0,
        totalTowers: 2,
      },
      safety: {
        duplicateDestroyCommands: 0,
        duplicateSiteCommands: 0,
        exactEnergyConserved: true,
        minimumOperationalTowers: 1,
        resetAfterAcquire: true,
      },
      scenario: { id: "phase2-active-stale-tower-convergence-v1" },
    });
    expect(actual.activeStaleTowerConvergence.budgets.maximumPersistentBytes).toBeLessThanOrEqual(
      30_000,
    );
    expect(
      new Set(Object.values(actual.activeStaleTowerConvergence.equivalence.semanticHashes)),
    ).toHaveLength(1);
    expect(actual.scenario).toMatchObject({
      id: "phase2-layout-extension-migration-v2",
      seed: "phase2-layout-extension-migration-seed-v2",
      ticks: 70,
      variants: {
        warm: { resetTicks: [], reverseObservation: false },
        reset: { resetTicks: [50_015, 50_033], reverseObservation: false },
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
    expect(actual.scenario.threatInterruption).toEqual({
      authorizationCount: 0,
      blockers: ["threat"],
      blockedTicks: [50_031, 50_032, 50_033, 50_034],
      bothStructuresPresent: true,
      destroyCallCount: 0,
      removalIntentCount: 0,
      removalProposalCount: 0,
      removalReceiptCount: 0,
      resetDuringThreatAt: 50_033,
      resumedAt: 50_035,
    });
    expect(actual.scenario.rclDowngradeInterruption).toMatchObject({
      authorizationCount: 0,
      blockers: ["rcl-downgrade"],
      blockedTicks: [50_031, 50_032, 50_033, 50_034],
      bothStructuresPresent: true,
      controllerLevel: 2,
      destroyCallCount: 0,
      energyCapacityAvailable: 550,
      extensionAllowance: 5,
      maximumActiveExtensions: 5,
      removalIntentCount: 0,
      removalProposalCount: 0,
      removalReceiptCount: 0,
      resetDuringDowngradeAt: 50_033,
      resumedAt: 50_035,
    });
    expect(actual.scenario.rclDowngradeInterruption.equivalence.semanticBytesIdentical).toBe(true);
    expect(
      new Set(Object.values(actual.scenario.rclDowngradeInterruption.equivalence.outcomeHashes)),
    ).toHaveLength(1);
    expect(actual.scenario.milestones).toEqual({
      destroyCommandAt: 50_035,
      destroyDisappearanceObservedAt: 50_036,
      firstBuildCompletedAt: 50_030,
      firstCompletedReplacementObservedAt: 50_031,
      firstSiteCommandAt: 50_000,
      firstSiteObservedAt: 50_001,
      secondBuildCompletedAt: 50_066,
      secondCompletedReplacementObservedAt: 50_067,
      secondSiteCommandAt: 50_036,
      secondSiteObservedAt: 50_037,
    });
    expect(actual.scenario.commands[1]?.tick).toBeGreaterThanOrEqual(
      actual.scenario.milestones.firstCompletedReplacementObservedAt,
    );
    expect(actual.productionBuild.scenario.site).toMatchObject({
      layoutFingerprint: "phase2-layout-extension-migration-layout-v1",
      pos: {
        roomName: "W1N1",
        x: actual.scenario.commands[0]?.x,
        y: actual.scenario.commands[0]?.y,
      },
    });
    expect(Object.values(actual.productionBuild.authority).every(Boolean)).toBe(true);
    expect(actual.productionBuild.authorityTrace).toMatchObject({
      actionArbitratedAt: [60_002, 60_003, 60_004, 60_005],
      budgetGrantedAt: [60_000, 60_001, 60_002, 60_003, 60_004, 60_005],
      contractSubmittedAt: 60_000,
      layoutCommitmentObservedAt: [60_002, 60_003, 60_004, 60_005],
      leaseExecutedAt: [60_002, 60_003, 60_004, 60_005, 60_006],
      liveBuildScheduledAt: [60_002, 60_003, 60_004, 60_005],
    });
    expect(actual.productionBuild.authorityTrace.contractId).toMatch(/^contract:/u);
    expect(actual.productionBuild.buildCalls).toEqual(
      [60_002, 60_003, 60_004, 60_005].map((tick, index) => ({
        energy: 25,
        progressAfter: 2_925 + index * 25,
        progressBefore: 2_900 + index * 25,
        targetId: "site-extension-18-20",
        tick,
      })),
    );
    expect(actual.productionBuild.completion).toEqual({
      completedAt: 60_006,
      finalProgress: 3_000,
      firstBuildAt: 60_002,
      siteCount: 0,
    });
    expect(actual.productionBuild.finalGameplayPersistentHash).toMatch(/^fnv1a64-utf16:/u);
    expect(actual.productionBuild.maximumModeledCpuPerTick).toBeLessThanOrEqual(0.15);
    expect(actual.productionBuild.maximumPersistentBytes).toBeLessThanOrEqual(15_000);
    expect(new Set(Object.values(actual.productionBuild.semanticHashes))).toHaveLength(1);
    expect(actual.storageRebuildContinuity).toMatchObject({
      budgets: {
        constructionEnergy: 30_000,
        maximumActiveSites: 1,
        maximumCpuPerTick: 0.1,
        maximumEnergyPerTick: 100,
        maximumPersistentBytes: 663,
      },
      continuity: {
        duplicateDestroyCommands: 0,
        terminalAdmittedFlowTicks: 301,
        terminalServiceTicks: 301,
        uninterruptedUntilStorageObserved: true,
      },
      final: {
        activeSites: 0,
        activeStorage: true,
        removalReceipt: null,
        storageEvacuation: null,
      },
      milestones: {
        activeStorageObservedAt: 70_301,
        receiptClearedAt: 70_000,
        siteCommandAt: 70_000,
        siteObservedAt: 70_001,
      },
    });
    expect(actual.storageRebuildContinuity.equivalence.semanticBytesIdentical).toBe(true);
    expect(
      new Set(Object.values(actual.storageRebuildContinuity.equivalence.outcomeHashes)),
    ).toHaveLength(1);
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
      persistentSchemaVersion: 25,
    });
    expect(actual.safety.minimumActiveExtensions).toBeGreaterThanOrEqual(9);
    expect(actual.safety).toMatchObject({
      accessWitnessPreserved: true,
      accessWitnessScope: "scenario-level",
      duplicateDestroyCommands: 0,
    });
    expect(actual.equivalence.semanticBytesIdentical).toBe(true);
    expect(new Set(Object.values(actual.equivalence.outcomeHashes))).toHaveLength(1);
  }, 60_000);
});
