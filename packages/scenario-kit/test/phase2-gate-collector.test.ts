import { describe, expect, it } from "vitest";
import checkedResult from "../../../docs/phase2-gate-results.json";
import checkedThresholds from "../../../docs/phase2-gate-thresholds.json";
import { COLONY_RCL_POLICY_TABLE } from "../../bot/src/colony";
import { buildRuntimeConfig } from "../../bot/src/config/runtime-config";
import {
  PHASE2_GATE_REQUIRED_LIMIT_IDS,
  collectPhase2GateEvidence,
  phase2GateSha256,
  validatePhase2GateThresholds,
} from "../src";

const COMPLETED_PREREQUISITES = [44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 99, 225];
const EVIDENCE_RECEIPTS = [
  "attrition",
  "colony-health",
  "cooldown-utilization",
  "industry",
  "industry-accounting",
  "labs",
  "layout-migration",
  "logistics",
  "maintenance",
  "mature",
  "mining",
  "rcl-transition",
  "telemetry",
].map((id, index) => ({
  id,
  sha256: `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
}));
const CONFIGURATION = {
  colonyRclPolicySha256: "sha256:21aea2469f73be385b715e695ea987cf3b3da7f25da9168bd1fd68a0289ee414",
  runtimeConfigSha256: "sha256:191eda26c52353a9c5b170377b1c3a69264046403e1ac4bb993a4d8a85dd788d",
};
const PRODUCTION_BUNDLE = {
  buildSha: "phase2-gate-evidence",
  bytes: 1_500_000,
  inputCount: 150,
  sha256: `sha256:${"a".repeat(64)}`,
};

describe("Phase 2 complete-colony gate collector (#54)", () => {
  it("streams the frozen progression and steady-state matrix within every declared bound", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const result = collectPhase2GateEvidence({
      completedPrerequisites: COMPLETED_PREREQUISITES,
      configuration: CONFIGURATION,
      evidenceReceipts: EVIDENCE_RECEIPTS,
      manifest,
      productionBundle: PRODUCTION_BUNDLE,
    });

    expect(result.status).toBe("pass");
    expect(result.evaluation).toEqual({ status: "within-thresholds", blockers: [] });
    expect(result.completedPrerequisites).toEqual(COMPLETED_PREREQUISITES);
    expect(result.measurements.values.map(({ id }) => id)).toEqual(PHASE2_GATE_REQUIRED_LIMIT_IDS);
    expect(result.progression.transitions).toEqual(
      manifest.progression.transitions.map(({ destinationRcl, maximumTicks }) => ({
        destinationRcl,
        ticks: maximumTicks,
      })),
    );
    expect(result.progression.totalTicks).toBe(1_820_000);
    expect(result.progression.finalRcl).toBe(8);
    expect(result.steadyState.observedTicks).toBe(15_000);
    expect(result.steadyState.sustainingTicks).toBeGreaterThanOrEqual(13_500);
    expect(result.steadyState.finalSustainingTicks).toBeGreaterThanOrEqual(1_500);
    expect(result.steadyState.injections.map(({ id }) => id)).toEqual(
      manifest.injections.map(({ id }) => id),
    );
    for (const receipt of result.steadyState.injections) {
      const threshold = manifest.limits.find(({ id }) => id === receipt.recoveryLimitId);
      if (threshold === undefined) throw new Error(`missing threshold ${receipt.recoveryLimitId}`);
      expect(receipt.preHealth).toBe("sustaining");
      expect(receipt.restoredHealth).toBe("sustaining");
      expect(receipt.recoveryTicks).toBeLessThanOrEqual(threshold.value);
      expect(receipt.restoredAt).toBe(receipt.startedAt + receipt.recoveryTicks);
    }
    expect(result.structurePolicies).toHaveLength(17);
    expect(result.structurePolicies.map(({ status }) => status)).toEqual(
      Array.from({ length: 17 }, () => "owned-policy-ready"),
    );
    expect(
      new Set(Object.values(result.measurements.attestation.progression).slice(1)),
    ).toHaveLength(1);
    expect(
      new Set(Object.values(result.measurements.attestation.steadyState).slice(1)),
    ).toHaveLength(1);
  });

  it("exactly reproduces the checked Phase 2 evidence artifact", () => {
    expect(checkedResult.configuration).toEqual({
      colonyRclPolicySha256: phase2GateSha256(COLONY_RCL_POLICY_TABLE),
      runtimeConfigSha256: phase2GateSha256(buildRuntimeConfig()),
    });
    const result = collectPhase2GateEvidence({
      completedPrerequisites: checkedResult.completedPrerequisites,
      configuration: checkedResult.configuration,
      evidenceReceipts: checkedResult.evidenceReceipts,
      manifest: validatePhase2GateThresholds(checkedThresholds),
      productionBundle: checkedResult.productionBundle,
    });

    expect(result).toEqual(checkedResult);
  });

  it("is repeatable and rejects incomplete frozen evidence", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const input = {
      completedPrerequisites: COMPLETED_PREREQUISITES,
      configuration: CONFIGURATION,
      evidenceReceipts: EVIDENCE_RECEIPTS,
      manifest,
      productionBundle: PRODUCTION_BUNDLE,
    } as const;
    expect(collectPhase2GateEvidence(input)).toEqual(collectPhase2GateEvidence(input));
    expect(() =>
      collectPhase2GateEvidence({
        ...input,
        completedPrerequisites: COMPLETED_PREREQUISITES.slice(1),
      }),
    ).toThrow(/prerequisite/u);
    expect(() =>
      collectPhase2GateEvidence({
        ...input,
        evidenceReceipts: EVIDENCE_RECEIPTS.slice(1),
      }),
    ).toThrow(/evidence receipt/u);
  });
});
