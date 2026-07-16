import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PRIVATE_SERVER_FIXTURE_STATE_LIMITS = Object.freeze({ maximumDefinitionBytes: 4_096 });

/** Checks the fixed ignored fixture path without creating, deleting, or following any component. */
export async function validatePrivateServerFixtureStatePath({ checkout, stateDirectory }) {
  await fixturePaths(checkout, stateDirectory);
}

/** Prepares only the fixed committed mod mapping; the definition remains absent until paused. */
export async function preparePrivateServerFixtureModuleState({ checkout, stateDirectory }) {
  const paths = await fixturePaths(checkout, stateDirectory);
  const modulePath = join(paths.checkout, "integration/private-server/fixtures/myrmex-fixture.cjs");
  await rm(paths.root, { force: true, recursive: true });
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.mods, JSON.stringify({ mods: [modulePath] }), "utf8");
  return publicPaths(stateDirectory);
}

/** Verifies that lifecycle start can load only the one committed fixture module mapping. */
export async function validatePrivateServerFixtureModuleState({ checkout, stateDirectory }) {
  const paths = await fixturePaths(checkout, stateDirectory, ["mods.json"]);
  const modulePath = join(paths.checkout, "integration/private-server/fixtures/myrmex-fixture.cjs");
  await rejectSymbolicLinkComponents(paths.checkout, modulePath);
  const moduleStat = await lstat(modulePath);
  if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
    throw new Error("Private-server fixture module mapping is invalid.");
  }
  const serialized = await readFile(paths.mods, "utf8");
  if (Buffer.byteLength(serialized, "utf8") > 1_024) {
    throw new Error("Private-server fixture module mapping is invalid.");
  }
  let mapping;
  try {
    mapping = JSON.parse(serialized);
  } catch {
    throw new Error("Private-server fixture module mapping is invalid.");
  }
  if (
    typeof mapping !== "object" ||
    mapping === null ||
    Array.isArray(mapping) ||
    Object.keys(mapping).length !== 1 ||
    !Array.isArray(mapping.mods) ||
    mapping.mods.length !== 1 ||
    mapping.mods[0] !== modulePath
  ) {
    throw new Error("Private-server fixture module mapping is invalid.");
  }
}

/** Atomically publishes one bounded definition after the simulation has been paused. */
export async function writePrivateServerFixtureDefinition({
  checkout,
  stateDirectory,
  definition,
}) {
  const paths = await fixturePaths(checkout, stateDirectory, [
    "definition.json",
    "definition.json.pending",
  ]);
  const serialized = JSON.stringify(definition);
  if (
    Buffer.byteLength(serialized, "utf8") >
    PRIVATE_SERVER_FIXTURE_STATE_LIMITS.maximumDefinitionBytes
  ) {
    throw new RangeError("Private-server fixture definition exceeds the byte limit.");
  }
  await mkdir(paths.root, { recursive: true });
  await rm(paths.pending, { force: true });
  await writeFile(paths.pending, serialized, { encoding: "utf8", flag: "wx" });
  await rename(paths.pending, paths.definition);
  return publicPaths(stateDirectory).definition;
}

/** Removes only the generated fixture directory inside the selected ignored state root. */
export async function clearPrivateServerFixtureState({ checkout, stateDirectory }) {
  const paths = await fixturePaths(checkout, stateDirectory);
  await rm(paths.root, { force: true, recursive: true });
}

async function fixturePaths(checkout, stateDirectory, filenames = []) {
  const resolvedCheckout = await realpath(resolve(checkout));
  const stateRoot = resolve(resolvedCheckout, stateDirectory);
  const stateRelative = relative(resolvedCheckout, stateRoot);
  if (
    stateRelative.length === 0 ||
    stateRelative === ".." ||
    stateRelative.startsWith(`..${sep}`) ||
    isAbsolute(stateRelative)
  ) {
    throw new Error("Private-server fixture state must remain inside the checkout.");
  }
  const root = join(stateRoot, "fixtures");
  await rejectSymbolicLinkComponents(resolvedCheckout, root);
  for (const filename of filenames) {
    await rejectSymbolicLinkComponents(resolvedCheckout, join(root, filename));
  }
  return Object.freeze({
    checkout: resolvedCheckout,
    definition: join(root, "definition.json"),
    mods: join(root, "mods.json"),
    pending: join(root, "definition.json.pending"),
    root,
  });
}

async function rejectSymbolicLinkComponents(checkout, target) {
  const targetRelative = relative(checkout, target);
  let current = checkout;
  for (const component of targetRelative.split(sep)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Private-server fixture state cannot contain symbolic links.");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function publicPaths(stateDirectory) {
  return Object.freeze({
    definition: join(stateDirectory, "fixtures/definition.json"),
    mods: join(stateDirectory, "fixtures/mods.json"),
  });
}
