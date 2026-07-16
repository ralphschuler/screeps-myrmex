import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearPrivateServerFixtureState,
  preparePrivateServerFixtureModuleState,
  PRIVATE_SERVER_FIXTURE_STATE_LIMITS,
  validatePrivateServerFixtureModuleState,
  writePrivateServerFixtureDefinition,
} from "../lib/private-server-fixture-state.mjs";

describe("private-server fixture state", () => {
  it("prepares, publishes, and clears only the fixed generated fixture paths", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "myrmex-checkout-"));
    const stateDirectory = ".private-state";
    const paths = await preparePrivateServerFixtureModuleState({ checkout, stateDirectory });

    expect(paths).toEqual({
      definition: join(stateDirectory, "fixtures/definition.json"),
      mods: join(stateDirectory, "fixtures/mods.json"),
    });
    expect(JSON.parse(await readFile(join(checkout, paths.mods), "utf8"))).toEqual({
      mods: [
        join(await realpath(checkout), "integration/private-server/fixtures/myrmex-fixture.cjs"),
      ],
    });
    await expect(access(join(checkout, paths.definition))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writePrivateServerFixtureDefinition({
      checkout,
      stateDirectory,
      definition: { scenarioId: "hostile-v1" },
    });
    expect(JSON.parse(await readFile(join(checkout, paths.definition), "utf8"))).toEqual({
      scenarioId: "hostile-v1",
    });

    await clearPrivateServerFixtureState({ checkout, stateDirectory });
    await expect(access(join(checkout, stateDirectory, "fixtures"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts exactly 4 KiB, rejects the next byte, and keeps state inside the checkout", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "myrmex-checkout-"));
    const stateDirectory = ".private-state";
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ value: "" }), "utf8");
    const exactDefinition = {
      value: "x".repeat(PRIVATE_SERVER_FIXTURE_STATE_LIMITS.maximumDefinitionBytes - envelopeBytes),
    };

    await expect(
      writePrivateServerFixtureDefinition({
        checkout,
        stateDirectory,
        definition: exactDefinition,
      }),
    ).resolves.toBe(join(stateDirectory, "fixtures/definition.json"));
    await expect(
      writePrivateServerFixtureDefinition({
        checkout,
        stateDirectory,
        definition: { value: `${exactDefinition.value}x` },
      }),
    ).rejects.toThrow("byte limit");
    await expect(
      preparePrivateServerFixtureModuleState({ checkout, stateDirectory: "../outside" }),
    ).rejects.toThrow("inside the checkout");
  });

  it("accepts only the exact committed fixture module mapping", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "myrmex-checkout-"));
    const stateDirectory = ".private-state";
    const moduleDirectory = join(checkout, "integration/private-server/fixtures");
    await mkdir(moduleDirectory, { recursive: true });
    await writeFile(
      join(moduleDirectory, "myrmex-fixture.cjs"),
      "module.exports=()=>undefined;",
      "utf8",
    );
    const paths = await preparePrivateServerFixtureModuleState({ checkout, stateDirectory });

    await expect(
      validatePrivateServerFixtureModuleState({ checkout, stateDirectory }),
    ).resolves.toBeUndefined();

    await writeFile(
      join(checkout, paths.mods),
      JSON.stringify({ mods: [join(checkout, "external.cjs")] }),
      "utf8",
    );
    await expect(
      validatePrivateServerFixtureModuleState({ checkout, stateDirectory }),
    ).rejects.toThrow("mapping is invalid");
  });

  it("rejects a symlinked state root without deleting or writing outside the checkout", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "myrmex-checkout-"));
    const outside = await mkdtemp(join(tmpdir(), "myrmex-outside-"));
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "preserve", "utf8");
    await symlink(outside, join(checkout, ".private-state"), "dir");

    await expect(
      preparePrivateServerFixtureModuleState({
        checkout,
        stateDirectory: ".private-state",
      }),
    ).rejects.toThrow("symbolic links");
    await expect(
      clearPrivateServerFixtureState({ checkout, stateDirectory: ".private-state" }),
    ).rejects.toThrow("symbolic links");
    await expect(
      validatePrivateServerFixtureModuleState({ checkout, stateDirectory: ".private-state" }),
    ).rejects.toThrow("symbolic links");
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
    await expect(access(join(outside, "fixtures"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked fixture root before publication or cleanup can escape", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "myrmex-checkout-"));
    const outside = await mkdtemp(join(tmpdir(), "myrmex-outside-"));
    const stateDirectory = ".private-state";
    const sentinel = join(outside, "definition.json");
    await mkdir(join(checkout, stateDirectory), { recursive: true });
    await writeFile(sentinel, "preserve", "utf8");
    await symlink(outside, join(checkout, stateDirectory, "fixtures"), "dir");

    await expect(
      writePrivateServerFixtureDefinition({
        checkout,
        definition: { scenarioId: "hostile-v1" },
        stateDirectory,
      }),
    ).rejects.toThrow("symbolic links");
    await expect(clearPrivateServerFixtureState({ checkout, stateDirectory })).rejects.toThrow(
      "symbolic links",
    );
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
    await expect(access(join(outside, "definition.json.pending"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
