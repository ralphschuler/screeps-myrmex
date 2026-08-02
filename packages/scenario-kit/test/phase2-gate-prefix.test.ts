import { describe, expect, it } from "vitest";
import {
  PHASE2_GATE_DECLARATION_SHA256_V1,
  PHASE2_GATE_PREFIX_ARTIFACT_KIND,
  PHASE2_GATE_PREFIX_EXECUTOR,
  PHASE2_GATE_PREFIX_SCHEMA_VERSION,
  PHASE2_RCL2_RCL3_PREFIX_ID,
  PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED,
  PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS,
  validatePhase2GatePrefixReceipt,
} from "../src";

describe("Phase 2 current-production prefix receipt", () => {
  it("accepts, detaches, and deeply freezes the finite RCL2-RCL3 receipt", () => {
    const input = validReceipt();
    const receipt = validatePhase2GatePrefixReceipt(input);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      artifactKind: "phase2-production-prefix-receipt",
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
    expect(receipt.scope.observedLimitIds).toEqual(PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS);
    expect(receipt.scope.notClaimed).toEqual(PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED);
    expect(receipt.variants.map(({ name }) => name)).toEqual(["warm", "reset", "reordered"]);
    expect(receipt.variants.map(({ resetAtProgressionTicks }) => resetAtProgressionTicks)).toEqual([
      [],
      [1_000],
      [],
    ]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.attestation.productionBundle)).toBe(true);
    expect(Object.isFrozen(receipt.variants[0].deferredEffects.harvest)).toBe(true);

    input.variants[0].semanticHash = "mutated";
    expect(receipt.variants[0].semanticHash).toBe(SEMANTIC_HASH);
  });

  it("rejects extra or missing fields at every receipt boundary", () => {
    expect(() => validatePhase2GatePrefixReceipt({ ...validReceipt(), extra: true })).toThrow(
      /unexpected fields/u,
    );

    const nested = cloneReceipt();
    Object.assign(nested.attestation.configuration, { branch: "main" });
    expect(() => validatePhase2GatePrefixReceipt(nested)).toThrow(/unexpected fields/u);

    const effect = cloneReceipt();
    Object.assign(effect.variants[0].deferredEffects.harvest, { immediate: false });
    expect(() => validatePhase2GatePrefixReceipt(effect)).toThrow(/unexpected fields/u);

    const missing = cloneReceipt();
    const withoutState = { ...missing.variants[0] } as Partial<(typeof missing.variants)[number]>;
    delete withoutState.state;
    missing.variants[0] = withoutState as (typeof missing.variants)[number];
    expect(() => validatePhase2GatePrefixReceipt(missing)).toThrow(/unexpected fields/u);
  });

  it("pins the diagnostic, non-composable identity and exact revision attestations", () => {
    const complete = cloneReceipt();
    complete.gateComplete = true;
    expect(() => validatePhase2GatePrefixReceipt(complete)).toThrow(/cannot complete or compose/u);

    const composable = cloneReceipt();
    composable.composable = true;
    expect(() => validatePhase2GatePrefixReceipt(composable)).toThrow(
      /cannot complete or compose/u,
    );

    const executor = cloneReceipt();
    Object.assign(executor, { executor: "analytical-model" });
    expect(() => validatePhase2GatePrefixReceipt(executor)).toThrow(/production runTick/u);

    const manifest = cloneReceipt();
    Object.assign(manifest.attestation, { thresholdManifestSha256: sha256("0") });
    expect(() => validatePhase2GatePrefixReceipt(manifest)).toThrow(/threshold manifest SHA-256/u);

    const fixture = cloneReceipt();
    fixture.attestation.fixtureSha256 = "latest";
    expect(() => validatePhase2GatePrefixReceipt(fixture)).toThrow(/fixture SHA-256/u);

    const bundle = cloneReceipt();
    bundle.attestation.productionBundle.inputCount = 0;
    expect(() => validatePhase2GatePrefixReceipt(bundle)).toThrow(/input count.*positive/u);

    const configuration = cloneReceipt();
    configuration.attestation.configuration.runtimeConfigSha256 = sha256("A");
    expect(() => validatePhase2GatePrefixReceipt(configuration)).toThrow(/runtime config SHA-256/u);
  });

  it("pins the eight observed rows and seven explicitly unclaimed rows in order", () => {
    const observed = cloneReceipt();
    observed.scope.observedLimitIds.reverse();
    expect(() => validatePhase2GatePrefixReceipt(observed)).toThrow(/observed limit ids/u);

    const omitted = cloneReceipt();
    omitted.scope.observedLimitIds.pop();
    expect(() => validatePhase2GatePrefixReceipt(omitted)).toThrow(/observed limit ids/u);

    const claimed = cloneReceipt();
    claimed.scope.notClaimed = claimed.scope.notClaimed.filter(
      (row) => row !== "full-gate-evaluation",
    );
    expect(() => validatePhase2GatePrefixReceipt(claimed)).toThrow(/unclaimed rows/u);

    const expanded = cloneReceipt();
    expanded.scope.destinationRcl = 4;
    expect(() => validatePhase2GatePrefixReceipt(expanded)).toThrow(/frozen RCL2-RCL3 row/u);
  });

  it("requires consecutive production ticks and exactly the declared reset and reorder variants", () => {
    const order = cloneReceipt();
    [order.variants[0], order.variants[1]] = [order.variants[1], order.variants[0]];
    expect(() => validatePhase2GatePrefixReceipt(order)).toThrow(/variant order or name/u);

    const reset = cloneReceipt();
    reset.variants[1].resetAtProgressionTicks = [];
    expect(() => validatePhase2GatePrefixReceipt(reset)).toThrow(/reset reset ticks/u);

    const reordered = cloneReceipt();
    reordered.variants[2].collectionOrder = "forward";
    expect(() => validatePhase2GatePrefixReceipt(reordered)).toThrow(/collection order/u);

    const calls = cloneReceipt();
    calls.variants[0].runTickCalls -= 1;
    expect(() => validatePhase2GatePrefixReceipt(calls)).toThrow(/one production runTick call/u);

    const skipped = cloneReceipt();
    skipped.variants[0].skippedTicks = 1;
    expect(() => validatePhase2GatePrefixReceipt(skipped)).toThrow(/cannot skip/u);

    const late = cloneReceipt();
    late.variants[0].progressionTicks = 5_001;
    late.variants[0].runTickCalls = 5_001;
    expect(() => validatePhase2GatePrefixReceipt(late)).toThrow(/5,000-tick ceiling/u);

    const resetNotExecuted = cloneReceipt();
    resetNotExecuted.variants[1].progressionTicks = 999;
    resetNotExecuted.variants[1].runTickCalls = 999;
    expect(() => validatePhase2GatePrefixReceipt(resetNotExecuted)).toThrow(
      /reset tick was not executed/u,
    );
  });

  it("requires exact controller energy and real following-tick effects for all four commands", () => {
    const controller = cloneReceipt();
    controller.variants[0].controller.observedUpgradeEnergy = 44_999;
    expect(() => validatePhase2GatePrefixReceipt(controller)).toThrow(/controller evidence/u);

    const impossibleOverflow = cloneReceipt();
    impossibleOverflow.variants[0].controller.finalProgress = 6;
    expect(() => validatePhase2GatePrefixReceipt(impossibleOverflow)).toThrow(
      /controller evidence/u,
    );

    const hiddenEnergy = cloneReceipt();
    hiddenEnergy.variants[0].controller.totalUpgradeEnergy = 45_004;
    expect(() => validatePhase2GatePrefixReceipt(hiddenEnergy)).toThrow(/controller evidence/u);

    const impossibleTransitionTick = cloneReceipt();
    impossibleTransitionTick.variants[0].controller.finalProgress = 8_193;
    impossibleTransitionTick.variants[0].controller.sameTickOverflowEnergy = 8_193;
    impossibleTransitionTick.variants[0].controller.totalUpgradeEnergy = 53_193;
    expect(() => validatePhase2GatePrefixReceipt(impossibleTransitionTick)).toThrow(
      /exceeds 8192/u,
    );

    const mutation = cloneReceipt();
    mutation.variants[0].controller.directProgressMutations = 1;
    expect(() => validatePhase2GatePrefixReceipt(mutation)).toThrow(/controller evidence/u);

    const missingSpawn = cloneReceipt();
    missingSpawn.variants[0].deferredEffects.spawn.successfulCalls = 0;
    expect(() => validatePhase2GatePrefixReceipt(missingSpawn)).toThrow(
      /spawn successful calls.*positive/u,
    );

    const noSettlement = cloneReceipt();
    noSettlement.variants[0].deferredEffects.upgrade.settledEffects = 0;
    expect(() => validatePhase2GatePrefixReceipt(noSettlement)).toThrow(
      /upgrade settled effects.*positive/u,
    );

    const unsettledSuccessfulCall = cloneReceipt();
    unsettledSuccessfulCall.variants[0].deferredEffects.upgrade.successfulCalls = 2;
    expect(() => validatePhase2GatePrefixReceipt(unsettledSuccessfulCall)).toThrow(
      /upgrade successful calls and settled effects must match/u,
    );

    const immediate = cloneReceipt();
    immediate.variants[0].deferredEffects.build.minimumSettlementDelayTicks = 0;
    expect(() => validatePhase2GatePrefixReceipt(immediate)).toThrow(
      /build minimum settlement delay.*positive/u,
    );

    const delayed = cloneReceipt();
    delayed.variants[0].deferredEffects.upgrade.minimumSettlementDelayTicks = 2;
    expect(() => validatePhase2GatePrefixReceipt(delayed)).toThrow(
      /upgrade effects must settle on the following tick/u,
    );

    const sameTick = cloneReceipt();
    sameTick.variants[0].deferredEffects.sameTickEffects = 1;
    expect(() => validatePhase2GatePrefixReceipt(sameTick)).toThrow(/only on later ticks/u);
  });

  it("fails closed on state-limit violations, faults, interruptions, and semantic drift", () => {
    const memory = cloneReceipt();
    memory.variants[0].state.maximumPersistentMemoryBytes = 65_537;
    expect(() => validatePhase2GatePrefixReceipt(memory)).toThrow(/exceeds 65536/u);

    const namespaces = cloneReceipt();
    namespaces.variants[0].state.maximumCacheNamespaces = 4;
    expect(() => validatePhase2GatePrefixReceipt(namespaces)).toThrow(/exceeds 3/u);

    const fault = cloneReceipt();
    fault.variants[0].kernelFaults = 1;
    expect(() => validatePhase2GatePrefixReceipt(fault)).toThrow(
      /forbidden fault or interruption/u,
    );

    const interrupted = cloneReceipt();
    interrupted.variants[0].rclEvidenceInterruptions = 1;
    expect(() => validatePhase2GatePrefixReceipt(interrupted)).toThrow(
      /forbidden fault or interruption/u,
    );

    const laterPhase = cloneReceipt();
    laterPhase.variants[0].forbiddenLaterPhaseActions = 1;
    expect(() => validatePhase2GatePrefixReceipt(laterPhase)).toThrow(
      /forbidden fault or interruption/u,
    );

    const malformedHash = cloneReceipt();
    for (const variant of malformedHash.variants) variant.semanticHash = "x";
    expect(() => validatePhase2GatePrefixReceipt(malformedHash)).toThrow(
      /semantic hash is malformed/u,
    );

    const drift = cloneReceipt();
    drift.variants[2].semanticHash = "fnv1a64-utf16:fedcba9876543210";
    expect(() => validatePhase2GatePrefixReceipt(drift)).toThrow(/semantic hashes diverged/u);
  });
});

const SEMANTIC_HASH = "fnv1a64-utf16:0123456789abcdef";

function validReceipt() {
  const deferredEffect = () => ({
    successfulCalls: 1,
    settledEffects: 1,
    minimumSettlementDelayTicks: 1,
  });
  const variant = (
    name: "warm" | "reset" | "reordered",
    collectionOrder: "forward" | "reversed",
    resetAtProgressionTicks: number[],
  ) => ({
    name,
    collectionOrder,
    resetAtProgressionTicks,
    firstTick: 100,
    progressionTicks: 4_999,
    runTickCalls: 4_999,
    skippedTicks: 0,
    controller: {
      startLevel: 2,
      startProgress: 0,
      startProgressTotal: 45_000,
      finalLevel: 3,
      finalProgress: 5,
      observedUpgradeEnergy: 45_000,
      totalUpgradeEnergy: 45_005,
      sameTickOverflowEnergy: 5,
      directProgressMutations: 0,
    },
    deferredEffects: {
      harvest: deferredEffect(),
      build: deferredEffect(),
      spawn: deferredEffect(),
      upgrade: deferredEffect(),
      sameTickEffects: 0,
      invalidSettlementDelays: 0,
    },
    state: {
      maximumPersistentMemoryBytes: 65_536,
      maximumTelemetryOwnerBytes: 8_192,
      maximumTickTelemetryBytes: 8_192,
      maximumCacheEntries: 384,
      maximumCacheNamespaces: 3,
    },
    kernelFaults: 0,
    rclEvidenceInterruptions: 0,
    forbiddenLaterPhaseActions: 0,
    semanticHash: SEMANTIC_HASH,
  });

  const variants: [
    ReturnType<typeof variant>,
    ReturnType<typeof variant>,
    ReturnType<typeof variant>,
  ] = [
    variant("warm", "forward", []),
    variant("reset", "forward", [1_000]),
    variant("reordered", "reversed", []),
  ];

  return {
    schemaVersion: PHASE2_GATE_PREFIX_SCHEMA_VERSION,
    artifactKind: PHASE2_GATE_PREFIX_ARTIFACT_KIND,
    issue: 54,
    id: PHASE2_RCL2_RCL3_PREFIX_ID,
    gateComplete: false,
    composable: false,
    executor: PHASE2_GATE_PREFIX_EXECUTOR,
    attestation: {
      thresholdManifestSha256: PHASE2_GATE_DECLARATION_SHA256_V1,
      fixtureSha256: sha256("b"),
      productionBundle: {
        buildSha: "bb0024ac5afcda935182efc88d8e11359feb09a1",
        bytes: 123_456,
        inputCount: 234,
        sha256: sha256("c"),
      },
      configuration: {
        colonyRclPolicySha256: sha256("d"),
        runtimeConfigSha256: sha256("e"),
      },
    },
    scope: {
      startRcl: 2,
      destinationRcl: 3,
      progressionLimitId: "progression-rcl3-ticks",
      requiredControllerEnergy: 45_000,
      maximumProgressionTicks: 5_000,
      observedLimitIds: [...PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS],
      notClaimed: [...PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED],
    },
    variants,
  };
}

function cloneReceipt(): ReturnType<typeof validReceipt> {
  return JSON.parse(JSON.stringify(validReceipt())) as ReturnType<typeof validReceipt>;
}

function sha256(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
