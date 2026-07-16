import { cwd } from "node:process";
import {
  deployPrivateServerBundle,
  privateServerBundleIdentity,
} from "./lib/private-server-cli.mjs";

const bundlePath = `${cwd()}/dist/main.js`;
const identity = await privateServerBundleIdentity(bundlePath);

try {
  const result = await deployPrivateServerBundle(bundlePath);
  process.stdout.write(`${JSON.stringify({ kind: "bundle-deployed", ...identity, result })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ kind: "deployment-failed", ...identity, reason: message })}\n`,
  );
  process.exitCode = 1;
}
