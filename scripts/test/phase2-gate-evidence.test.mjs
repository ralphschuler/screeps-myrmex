import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import checkedResult from "../../docs/phase2-gate-results.json" with { type: "json" };
import { buildBotBundle } from "../lib/build-bot.mjs";
import { forbiddenBundleInputs } from "../lib/bundle-boundaries.mjs";

const EVIDENCE_FILES = new Map([
  ["attrition", "docs/phase2-attrition-results.json"],
  ["colony-health", "docs/phase2-colony-health-results.json"],
  ["cooldown-utilization", "docs/phase2-cooldown-utilization-results.json"],
  ["industry", "docs/phase2-industry-results.json"],
  ["industry-accounting", "docs/phase2-industry-accounting-results.json"],
  ["labs", "docs/phase2-labs-results.json"],
  ["layout-migration", "docs/phase2-layout-migration-results.json"],
  ["logistics", "docs/phase2-logistics-results.json"],
  ["maintenance", "docs/phase2-maintenance-results.json"],
  ["mature", "docs/phase2-mature-results.json"],
  ["mining", "docs/phase2-mining-results.json"],
  ["rcl-transition", "docs/phase2-rcl-transition-results.json"],
  ["telemetry", "docs/phase2-telemetry-results.json"],
]);

describe("Phase 2 exact complete-colony gate evidence (#54)", () => {
  it("rebuilds the attested production bundle and prerequisite receipts", async () => {
    const bundle = await buildBotBundle({ buildSha: checkedResult.productionBundle.buildSha });

    expect(forbiddenBundleInputs(Object.keys(bundle.metafile.inputs))).toEqual([]);
    expect(bundle.evidence).toEqual(checkedResult.productionBundle);
    expect(checkedResult.measurements.attestation.productionBundleSha256).toBe(
      bundle.evidence.sha256,
    );
    expect(checkedResult.evidenceReceipts).toHaveLength(EVIDENCE_FILES.size);
    for (const receipt of checkedResult.evidenceReceipts) {
      const path = EVIDENCE_FILES.get(receipt.id);
      if (path === undefined) throw new Error(`unknown Phase 2 evidence receipt ${receipt.id}`);
      const contents = await readFile(path);
      expect(receipt.sha256).toBe(`sha256:${createHash("sha256").update(contents).digest("hex")}`);
    }
  }, 30_000);
});
