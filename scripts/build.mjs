import { mkdir, rm, writeFile } from "node:fs/promises";
import { buildBotBundle } from "./lib/build-bot.mjs";

const buildSha = process.env.MYRMEX_BUILD_SHA?.trim() || "development";

await rm("dist", { force: true, recursive: true });
const result = await buildBotBundle({ buildSha, logLevel: "info" });
await mkdir("dist", { recursive: true });
await writeFile("dist/main.js", result.contents);
console.log(`Built dist/main.js (${String(result.evidence.bytes)} bytes).`);
