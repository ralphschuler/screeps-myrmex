import { describe, expect, it } from "vitest";
import checkedResult from "../../docs/phase1-gate-results.json" with { type: "json" };
import { buildBotBundle } from "../lib/build-bot.mjs";
import { forbiddenBundleInputs } from "../lib/bundle-boundaries.mjs";

describe("Phase 1 exact production bundle evidence (#30)", () => {
  it("matches the checked artifact hash and excludes scenario-kit from the real metafile", async () => {
    const result = await buildBotBundle({ buildSha: checkedResult.productionBundle.buildSha });
    expect(forbiddenBundleInputs(Object.keys(result.metafile.inputs))).toEqual([]);
    expect(result.evidence).toEqual(checkedResult.productionBundle);
  }, 30_000);
});
