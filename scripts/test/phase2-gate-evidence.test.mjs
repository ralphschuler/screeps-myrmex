import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import checkedResult from "../../docs/phase2-gate-results.json" with { type: "json" };
import checkedThresholds from "../../docs/phase2-gate-thresholds.json" with { type: "json" };
import {
  evaluatePhase2Gate,
  phase2GateSha256,
  validatePhase2GateThresholds,
} from "../../packages/scenario-kit/src/index.ts";
import { buildBotBundle } from "../lib/build-bot.mjs";
import { forbiddenBundleInputs } from "../lib/bundle-boundaries.mjs";

const CLOSURE_RESULT_SHA256 =
  "sha256:8222dd56b25220bf4e4e4c0940e76d743293c423066bb2421235abb71e78a0f1";
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

describe("Phase 2 closure evidence and current production compatibility (#54)", () => {
  it("keeps the historical closure attestation immutable and internally bound", async () => {
    const contents = await readFile(
      new URL("../../docs/phase2-gate-results.json", import.meta.url),
    );
    const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
    const manifest = validatePhase2GateThresholds(checkedThresholds);

    expect(digest).toBe(CLOSURE_RESULT_SHA256);
    expect(checkedResult).toMatchObject({
      evaluation: { blockers: [], status: "within-thresholds" },
      issue: 54,
      schemaVersion: 1,
      status: "pass",
    });
    expect(checkedResult.measurements.attestation.productionBundleSha256).toBe(
      checkedResult.productionBundle.sha256,
    );
    expect(checkedResult.measurements.attestation.manifestSha256).toBe(phase2GateSha256(manifest));
    expect(checkedResult.measurements.attestation.measurementSha256).toBe(
      phase2GateSha256(checkedResult.measurements.values),
    );
    expect(evaluatePhase2Gate(manifest, checkedResult.measurements)).toEqual(
      checkedResult.evaluation,
    );
    expect(checkedResult.evidenceReceipts).toHaveLength(EVIDENCE_FILES.size);
    for (const receipt of checkedResult.evidenceReceipts) {
      const path = EVIDENCE_FILES.get(receipt.id);
      if (path === undefined) throw new Error(`unknown Phase 2 evidence receipt ${receipt.id}`);
      const evidence = await readFile(new URL(`../../${path}`, import.meta.url));
      expect(`sha256:${createHash("sha256").update(evidence).digest("hex")}`).toBe(receipt.sha256);
    }
  });

  it("builds and executes the current deployable bundle without rewriting closure evidence", async () => {
    const bundle = await buildBotBundle({ buildSha: "phase2-head-compatibility" });
    const memory = {};
    const game = {
      cpu: { bucket: 10_000, getUsed: () => 0, limit: 20, tickLimit: 500 },
      creeps: {},
      constructionSites: {},
      getObjectById: () => null,
      market: { calcTransactionCost: () => 0 },
      rooms: {},
      shard: { name: "shard0" },
      time: 100,
    };
    const module = { exports: {} };

    expect(forbiddenBundleInputs(Object.keys(bundle.metafile.inputs))).toEqual([]);
    expect(bundle.evidence.buildSha).toBe("phase2-head-compatibility");
    runInNewContext(new TextDecoder().decode(bundle.contents), {
      Game: game,
      Memory: memory,
      console: { log: () => undefined },
      exports: module.exports,
      module,
    });
    expect(module.exports).toHaveProperty("loop");
    module.exports.loop();
    expect(memory).toMatchObject({
      myrmex: { telemetry: { last: { tick: 100 } } },
    });
  }, 30_000);
});
