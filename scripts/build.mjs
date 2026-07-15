import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { force: true, recursive: true });

await build({
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
