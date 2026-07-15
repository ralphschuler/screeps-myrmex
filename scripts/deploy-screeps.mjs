import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScreepsClient } from "./lib/screeps-client.mjs";

export function bundleDigest(code) {
  return createHash("sha256").update(code).digest("hex");
}

export async function deployBundle({ client, branch, code }) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(branch)) {
    throw new Error("SCREEPS_BRANCH contains unsupported characters.");
  }

  await client.post("user/code", {
    branch,
    modules: { main: code },
  });

  const deployed = await client.get("user/code", { branch });
  const remoteCode = deployed?.modules?.main;

  if (remoteCode !== code) {
    throw new Error("Screeps accepted the upload but bundle verification failed.");
  }

  return { branch, digest: bundleDigest(code) };
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  const client = new ScreepsClient({
    baseUrl: process.env.SCREEPS_API_BASE_URL,
    token: process.env.SCREEPS_TOKEN,
  });
  const branch = process.env.SCREEPS_BRANCH || "default";
  const code = await readFile(resolve("dist/main.js"), "utf8");
  const result = await deployBundle({ branch, client, code });

  console.log(`Verified Screeps deployment (${result.digest.slice(0, 12)}).`);
}
