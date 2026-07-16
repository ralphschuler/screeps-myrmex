import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PRIVATE_SERVER_RUNTIME_VERSION = "4.3.0";
export const PRIVATE_SERVER_LIMITS = Object.freeze({
  healthAttempts: 60,
  healthIntervalMs: 500,
  shutdownTimeoutMs: 5_000,
  startupTimeoutMs: 30_000,
});

/** Creates a secret-free, bounded lifecycle record suitable for later evidence artifacts. */
export function lifecycleRecord(kind, details = {}) {
  return Object.freeze({
    kind,
    runtime: `screeps@${PRIVATE_SERVER_RUNTIME_VERSION}`,
    ...details,
  });
}

export function parseLifecycleArguments(argv) {
  const values = { command: "health", stateDirectory: ".myrmex-private-server" };
  const [command = "health", ...rest] = argv;
  if (!new Set(["install", "init", "start", "health", "stop"]).has(command)) {
    throw new Error(`Unsupported private-server command: ${command}`);
  }
  values.command = command;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--state-directory") {
      const directory = rest[index + 1];
      if (typeof directory !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(directory)) {
        throw new Error("--state-directory must be a relative safe path.");
      }
      values.stateDirectory = directory;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported private-server option: ${option}`);
  }
  return Object.freeze(values);
}

export function lifecyclePaths(cwd, stateDirectory) {
  const checkout = resolve(cwd);
  const root = resolve(checkout, stateDirectory);
  if (!root.startsWith(`${checkout}/`)) {
    throw new Error("private-server state must remain inside the checkout.");
  }
  return Object.freeze({
    log: join(root, "launcher.log"),
    pid: join(root, "launcher.pid"),
    root,
  });
}

export async function readPid(paths) {
  try {
    const value = (await readFile(paths.pid, "utf8")).trim();
    return /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

export async function writePid(paths, pid) {
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.pid, `${pid}\n`, "utf8");
}

export async function clearPid(paths) {
  await rm(paths.pid, { force: true });
}

export async function waitForHealth(probe, limits = PRIVATE_SERVER_LIMITS) {
  for (let attempt = 1; attempt <= limits.healthAttempts; attempt += 1) {
    if (await probe()) return lifecycleRecord("healthy", { attempt });
    if (attempt < limits.healthAttempts) await delay(limits.healthIntervalMs);
  }
  return lifecycleRecord("health-timeout", { attempts: limits.healthAttempts });
}

export function redactLifecycleError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(token|password|key|secret)=\S+/gi, "$1=[redacted]")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
    .join("")
    .slice(0, 240);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
