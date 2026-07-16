import { cwd } from "node:process";
import { privateServerBundleIdentity } from "./lib/private-server-cli.mjs";

const identity = await privateServerBundleIdentity(`${cwd()}/dist/main.js`);
process.stdout.write(`${JSON.stringify({ kind: "bundle-identity", ...identity })}\n`);
