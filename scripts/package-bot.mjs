import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function assertPackageVersion(version) {
  if (!SEMVER.test(version)) {
    throw new Error(`Invalid package version: ${version}`);
  }
}

export async function prepareBotPackage({
  version,
  repositoryRoot = REPOSITORY_ROOT,
  outputDirectory = resolve(repositoryRoot, "dist/package"),
}) {
  assertPackageVersion(version);

  const bundlePath = resolve(repositoryRoot, "dist/main.js");
  await readFile(bundlePath, "utf8");
  await mkdir(outputDirectory, { recursive: true });

  const manifest = {
    name: "@ralphschuler/screeps-myrmex",
    version,
    description: "MYRMEX autonomous Screeps runtime bundle.",
    license: "MIT",
    type: "commonjs",
    main: "main.js",
    exports: "./main.js",
    files: ["main.js", "README.md", "LICENSE"],
    repository: {
      type: "git",
      url: "git+https://github.com/ralphschuler/screeps-myrmex.git",
    },
    publishConfig: {
      access: "public",
      registry: "https://npm.pkg.github.com",
    },
    screeps_bot: true,
  };

  await Promise.all([
    copyFile(bundlePath, resolve(outputDirectory, "main.js")),
    copyFile(resolve(repositoryRoot, "README.md"), resolve(outputDirectory, "README.md")),
    copyFile(resolve(repositoryRoot, "LICENSE"), resolve(outputDirectory, "LICENSE")),
    writeFile(
      resolve(outputDirectory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);

  return { manifest, outputDirectory };
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  const version = process.argv[2];

  if (version === undefined) {
    throw new Error("Usage: node scripts/package-bot.mjs <semver>");
  }

  const result = await prepareBotPackage({ version });
  console.log(`Prepared ${result.manifest.name}@${result.manifest.version}.`);
}
