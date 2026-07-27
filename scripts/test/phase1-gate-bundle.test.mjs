import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import checkedResult from "../../docs/phase1-gate-results.json" with { type: "json" };

const CLOSURE_RESULT_SHA256 =
  "sha256:f50ba099d0ce8aa870d7b9405095e29e5e4858225a5ab91c1bc884327a7bbee7";

describe("Phase 1 historical closure evidence (#30)", () => {
  it("keeps the closed result immutable and internally identifies its production bundle", async () => {
    const contents = await readFile(
      new URL("../../docs/phase1-gate-results.json", import.meta.url),
    );
    const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;

    expect(digest).toBe(CLOSURE_RESULT_SHA256);
    expect(checkedResult).toMatchObject({
      issue: 30,
      productionBundleExclusion: "evidenced-local",
      schemaVersion: 1,
      status: "complete",
    });
    expect(checkedResult.productionBundle).toMatchObject({
      buildSha: "phase1-gate-evidence",
      inputCount: 159,
      sha256: "sha256:5c7586fcad3800b114e0babc90dea2bd27f9823ae9f0916c16f34d096c540a28",
    });
  });
});
