import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  preparePrivateServerFixtureState,
  PRIVATE_SERVER_FIXTURE_STATE_LIMITS,
} from "../lib/private-server-fixture-state.mjs";

describe("private-server fixture state", () => {
  it("writes only a committed fixture module path and bounded ignored definition", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "myrmex-checkout-"));
    const result = await preparePrivateServerFixtureState({
      checkout,
      stateDirectory: ".private-state",
      definition: { scenarioId: "hostile-v1" },
    });
    expect(JSON.parse(await readFile(join(checkout, result.definition), "utf8"))).toEqual({
      scenarioId: "hostile-v1",
    });
    expect(JSON.parse(await readFile(join(checkout, result.mods), "utf8")).mods[0]).toContain(
      "integration/private-server/fixtures/myrmex-fixture.cjs",
    );
    await expect(
      preparePrivateServerFixtureState({
        checkout,
        stateDirectory: "../outside",
        definition: {
          value: "x".repeat(PRIVATE_SERVER_FIXTURE_STATE_LIMITS.maximumDefinitionBytes),
        },
      }),
    ).rejects.toThrow("inside the checkout");
  });
});
