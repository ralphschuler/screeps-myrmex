import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PRIVATE_SERVER_FIXTURE_STATE_LIMITS = Object.freeze({ maximumDefinitionBytes: 4_096 });

/** Creates the ignored, source-controlled mod configuration for one private-server scenario. */
export async function preparePrivateServerFixtureState({ checkout, stateDirectory, definition }) {
  const root = resolve(checkout, stateDirectory);
  if (!root.startsWith(`${resolve(checkout)}/`)) {
    throw new Error("Private-server fixture state must remain inside the checkout.");
  }
  const serialized = JSON.stringify(definition);
  if (
    Buffer.byteLength(serialized, "utf8") >
    PRIVATE_SERVER_FIXTURE_STATE_LIMITS.maximumDefinitionBytes
  ) {
    throw new RangeError("Private-server fixture definition exceeds the byte limit.");
  }
  const fixtures = join(root, "fixtures");
  const modulePath = join(
    resolve(checkout),
    "integration/private-server/fixtures/myrmex-fixture.cjs",
  );
  await mkdir(fixtures, { recursive: true });
  await writeFile(join(fixtures, "definition.json"), serialized, "utf8");
  await writeFile(join(fixtures, "mods.json"), JSON.stringify({ mods: [modulePath] }), "utf8");
  return Object.freeze({
    definition: join(stateDirectory, "fixtures/definition.json"),
    mods: join(stateDirectory, "fixtures/mods.json"),
  });
}
