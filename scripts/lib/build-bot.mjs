import { createHash } from "node:crypto";
import { build } from "esbuild";
import { assertDeployableBundle } from "./bundle-boundaries.mjs";

export async function buildBotBundle({ buildSha, logLevel = "silent" }) {
  assertBuildSha(buildSha);
  const result = await build({
    banner: { js: `// MYRMEX_BUILD_SHA=${buildSha}` },
    bundle: true,
    entryPoints: ["packages/bot/src/main.ts"],
    format: "cjs",
    legalComments: "none",
    logLevel,
    minify: false,
    metafile: true,
    outfile: "dist/main.js",
    platform: "neutral",
    sourcemap: false,
    target: "es2020",
    treeShaking: true,
    write: false,
  });
  assertDeployableBundle(result.metafile);
  const output = result.outputFiles.find(({ path }) =>
    path.replaceAll("\\", "/").endsWith("/dist/main.js"),
  );
  if (output === undefined) throw new Error("esbuild did not produce dist/main.js");
  return {
    contents: output.contents,
    evidence: Object.freeze({
      buildSha,
      bytes: output.contents.byteLength,
      inputCount: Object.keys(result.metafile.inputs).length,
      sha256: `sha256:${createHash("sha256").update(output.contents).digest("hex")}`,
    }),
    metafile: result.metafile,
  };
}

function assertBuildSha(buildSha) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(buildSha)) {
    throw new Error(
      "MYRMEX_BUILD_SHA must contain only letters, numbers, dots, underscores, or dashes.",
    );
  }
}
