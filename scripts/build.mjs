import { rm } from "node:fs/promises";
import { build } from "esbuild";

const buildSha = process.env.MYRMEX_BUILD_SHA?.trim() || "development";

if (!/^[A-Za-z0-9._-]{1,128}$/.test(buildSha)) {
  throw new Error(
    "MYRMEX_BUILD_SHA must contain only letters, numbers, dots, underscores, or dashes.",
  );
}

await rm("dist", { force: true, recursive: true });

await build({
  banner: { js: `// MYRMEX_BUILD_SHA=${buildSha}` },
  bundle: true,
  entryPoints: ["packages/bot/src/main.ts"],
  format: "cjs",
  legalComments: "none",
  logLevel: "info",
  minify: false,
  outfile: "dist/main.js",
  platform: "neutral",
  sourcemap: false,
  target: "es2020",
  treeShaking: true,
});
