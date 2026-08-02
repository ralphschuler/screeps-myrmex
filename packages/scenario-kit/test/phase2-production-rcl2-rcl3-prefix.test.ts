import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  collectPhase2Rcl2Rcl3PrefixReceipt,
  collectWarmPhase2Rcl2Rcl3Prefix,
  summarizeRcl2ControllerEffects,
} from "./fixtures/phase2-production-rcl2-rcl3-prefix";

const FIND_CREEPS_VALUE = 101;
const FIND_HOSTILE_CREEPS_VALUE = 102;
const FIND_SOURCES_VALUE = 105;
const FIND_DROPPED_RESOURCES_VALUE = 106;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

describe("Phase 2 finite current-production RCL2-RCL3 prefix (#54)", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_HOSTILE_CREEPS", FIND_HOSTILE_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", FIND_DROPPED_RESOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => vi.unstubAllGlobals());

  it("accounts for the crossing intent and later same-tick intents as explicit RCL3 overflow", () => {
    const effect = (
      actorId: string,
      commandTick: number,
      energy: number,
      levelBefore: number,
      progressBefore: number,
      levelAfter: number,
      progressAfter: number,
    ) => ({
      actorId,
      commandTick,
      energy,
      levelAfter,
      levelBefore,
      progressAfter,
      progressBefore,
      targetId: "controller-a",
      visibleAt: 101,
    });

    const prior = Array.from({ length: 918 }, (_, index) =>
      effect("worker", index, 49, 2, index * 49, 2, (index + 1) * 49),
    );
    expect(
      summarizeRcl2ControllerEffects([
        ...prior,
        effect("worker", 918, 17, 2, 44_982, 2, 44_999),
        effect("crossing-worker", 919, 3, 2, 44_999, 3, 2),
        effect("later-worker", 919, 3, 3, 2, 3, 5),
      ]),
    ).toEqual({
      finalProgress: 5,
      observedUpgradeEnergy: 45_000,
      sameTickOverflowEnergy: 5,
      totalUpgradeEnergy: 45_005,
    });
  });

  it("reaches RCL3 through one real runTick call for every warm-world tick", async () => {
    const { evidence } = await collectWarmPhase2Rcl2Rcl3Prefix();

    expect(evidence.name).toBe("warm");
    expect(evidence.progressionTicks).toBeLessThanOrEqual(5_000);
    expect(evidence.runTickCalls).toBe(evidence.progressionTicks);
    expect(evidence).toMatchObject({
      firstTick: 100,
      skippedTicks: 0,
      controller: {
        startLevel: 2,
        startProgress: 0,
        startProgressTotal: 45_000,
        finalLevel: 3,
        observedUpgradeEnergy: 45_000,
        directProgressMutations: 0,
      },
      deferredEffects: { sameTickEffects: 0, invalidSettlementDelays: 0 },
      kernelFaults: 0,
      rclEvidenceInterruptions: 0,
      forbiddenLaterPhaseActions: 0,
    });
    expect(evidence.controller.totalUpgradeEnergy).toBe(45_000 + evidence.controller.finalProgress);
    expect(evidence.controller.sameTickOverflowEnergy).toBe(evidence.controller.finalProgress);
  }, 120_000);

  it("emits a strict non-composable receipt from consecutive warm, reset, and reorder runs", async () => {
    const receipt = await collectPhase2Rcl2Rcl3PrefixReceipt();

    expect(receipt).toMatchObject({
      issue: 54,
      id: "phase2/production/progression-rcl2-rcl3-v1",
      gateComplete: false,
      composable: false,
      executor: "packages/bot/src/runtime/tick.runTick",
      scope: {
        startRcl: 2,
        destinationRcl: 3,
        requiredControllerEnergy: 45_000,
        maximumProgressionTicks: 5_000,
      },
    });
    expect(receipt.variants.map(({ name }) => name)).toEqual(["warm", "reset", "reordered"]);
    expect(receipt.variants.map(({ resetAtProgressionTicks }) => resetAtProgressionTicks)).toEqual([
      [],
      [1_000],
      [],
    ]);
    for (const variant of receipt.variants) {
      expect(variant.progressionTicks).toBeLessThanOrEqual(5_000);
      expect(variant.runTickCalls).toBe(variant.progressionTicks);
      expect(variant.deferredEffects).toMatchObject({
        sameTickEffects: 0,
        invalidSettlementDelays: 0,
      });
      expect(variant).toMatchObject({
        firstTick: 100,
        skippedTicks: 0,
        controller: {
          startLevel: 2,
          startProgress: 0,
          startProgressTotal: 45_000,
          finalLevel: 3,
          observedUpgradeEnergy: 45_000,
          directProgressMutations: 0,
        },
        kernelFaults: 0,
        rclEvidenceInterruptions: 0,
        forbiddenLaterPhaseActions: 0,
      });
      expect(variant.controller.totalUpgradeEnergy).toBe(45_000 + variant.controller.finalProgress);
      expect(variant.controller.sameTickOverflowEnergy).toBe(variant.controller.finalProgress);
    }
    expect(new Set(receipt.variants.map(({ semanticHash }) => semanticHash))).toHaveLength(1);
  }, 360_000);
});
