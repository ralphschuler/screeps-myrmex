import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const PRIVATE_SERVER_RUNTIME_VERSION = "4.3.0";
export const PRIVATE_SERVER_NODE_VERSION = "22.22.1";
export const PRIVATE_SERVER_LIMITS = Object.freeze({
  healthAttempts: 32,
  healthCliProbeTimeoutMs: 500,
  healthIntervalMs: 500,
  healthTcpProbeTimeoutMs: 250,
  shutdownAttempts: 50,
  shutdownIntervalMs: 100,
  shutdownTimeoutMs: 5_000,
  startupTimeoutMs: 60_000,
});

const READINESS_FAILURE_CODES = new Set([
  "cli-closed",
  "cli-connection-failed",
  "cli-port-unavailable",
  "cli-timeout",
  "game-port-unavailable",
  "launcher-exited",
  "readiness-receipt-invalid",
  "storage-not-ready",
  "storage-readiness-rejected",
]);
const SUCCESS_KINDS = new Set([
  "healthy",
  "initialized",
  "installed",
  "provisioned",
  "started",
  "stopped",
]);

/** Creates a secret-free, bounded lifecycle record suitable for later evidence artifacts. */
export function lifecycleRecord(kind, details = {}) {
  return Object.freeze({
    kind,
    runtime: `screeps@${PRIVATE_SERVER_RUNTIME_VERSION}`,
    ...details,
  });
}

export function privateServerLifecycleSucceeded(kind) {
  return SUCCESS_KINDS.has(kind);
}

/** Discards a dead PID and never reuses or kills a live PID without process identity evidence. */
export function privateServerExistingProcessAction(healthKind, healthReason) {
  if (healthKind === "health-timeout" && healthReason === "launcher-exited") return "discard";
  return "reject";
}

/** Rejects an unverified PID before any fixture preparation can mutate ignored state. */
export async function privateServerStartPreflight({
  discardPid,
  existingPid,
  fixtureScenarioId,
  prepareFixture,
  probeExisting,
}) {
  if (existingPid !== null) {
    const health = await probeExisting();
    const action = privateServerExistingProcessAction(health.kind, health.reason);
    if (action === "reject") return Object.freeze({ kind: "reject" });
    await discardPid();
  }
  if (fixtureScenarioId !== null) await prepareFixture();
  return Object.freeze({ kind: "ready" });
}

/** Runs the pinned launcher through the already-validated Node executable, never its env shebang. */
export function privateServerLauncherInvocation(nodeExecutable, launcherExecutable, args) {
  if (
    typeof nodeExecutable !== "string" ||
    nodeExecutable.length === 0 ||
    typeof launcherExecutable !== "string" ||
    launcherExecutable.length === 0 ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string")
  ) {
    throw new TypeError("Private-server launcher invocation is invalid.");
  }
  return Object.freeze({
    args: Object.freeze([launcherExecutable, ...args]),
    command: nodeExecutable,
  });
}

/** Runs npm's CLI with the same validated Node executable instead of resolving npm through PATH. */
export function privateServerNpmInvocation(nodeExecutable, args) {
  return privateServerLauncherInvocation(
    nodeExecutable,
    resolve(dirname(nodeExecutable), "../lib/node_modules/npm/bin/npm-cli.js"),
    args,
  );
}

export function parseLifecycleArguments(argv) {
  const values = {
    command: "health",
    fixtureScenarioId: null,
    stateDirectory: ".myrmex-private-server",
  };
  const [command = "health", ...rest] = argv;
  if (!new Set(["install", "init", "provision", "start", "health", "stop"]).has(command)) {
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
    if (option === "--fixture-scenario") {
      const scenarioId = rest[index + 1];
      if (typeof scenarioId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(scenarioId)) {
        throw new Error("--fixture-scenario must be a safe scenario id.");
      }
      values.fixtureScenarioId = scenarioId;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported private-server option: ${option}`);
  }
  return Object.freeze(values);
}

/** Accepts only a runtime-provided secret that can be passed to upstream initialization via stdin. */
export function privateServerProvisioningKey(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 256 || /[\r\n]/.test(value)) {
    return null;
  }
  return value;
}

/** Restricts the standalone runtime to the observed working Node 22 line. */
export function privateServerNodeSupported(version) {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match !== null && Number(match[1]) === 22 && Number(match[2]) >= 9;
}

/** Copies the process environment without forwarding the runtime-only Steam credential. */
export function privateServerChildEnvironment(source, additions = {}) {
  const child = { ...source, ...additions };
  delete child.SCREEPS_STEAM_API_KEY;
  return child;
}

/** Removes the upstream initializer's persisted Steam key while retaining all non-secret settings. */
export function scrubProvisionedConfig(value) {
  if (typeof value !== "string") throw new TypeError("Private-server configuration must be text.");
  return value.replace(/^steam_api_key\s*=.*(?:\r?\n|$)/m, "");
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

/** Starts each launcher attempt with an empty diagnostic log so its fixed failure code is current. */
export async function prepareLauncherLog(paths) {
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.log, "", "utf8");
}

export async function waitForHealth(probe, limits = PRIVATE_SERVER_LIMITS) {
  for (let attempt = 1; attempt <= limits.healthAttempts; attempt += 1) {
    if (await probe()) return lifecycleRecord("healthy", { attempt });
    if (attempt < limits.healthAttempts) await delay(limits.healthIntervalMs);
  }
  return lifecycleRecord("health-timeout", { attempts: limits.healthAttempts });
}

/** Waits for the process, both loopback listeners, and a read-only storage-backed CLI receipt. */
export async function waitForPrivateServerReadiness(probe, limits = PRIVATE_SERVER_LIMITS) {
  let reason = "game-port-unavailable";
  for (let attempt = 1; attempt <= limits.healthAttempts; attempt += 1) {
    const result = await probe();
    if (result?.ready === true) return lifecycleRecord("healthy", { attempt });
    reason = READINESS_FAILURE_CODES.has(result?.reason)
      ? result.reason
      : "storage-readiness-rejected";
    if (result?.terminal === true) {
      return lifecycleRecord("health-timeout", { attempt, reason });
    }
    if (attempt < limits.healthAttempts) await delay(limits.healthIntervalMs);
  }
  return lifecycleRecord("health-timeout", {
    attempts: limits.healthAttempts,
    reason,
  });
}

/** Probes each readiness boundary in order and stops at the first unavailable stage. */
export async function privateServerReadinessObservation({
  cliPort,
  gamePort,
  processStopped,
  storage,
}) {
  if (await processStopped()) {
    return Object.freeze({ ready: false, reason: "launcher-exited", terminal: true });
  }
  if (!(await gamePort())) {
    return Object.freeze({ ready: false, reason: "game-port-unavailable" });
  }
  if (!(await cliPort())) {
    return Object.freeze({ ready: false, reason: "cli-port-unavailable" });
  }
  return storage();
}

/** Waits until the detached launcher process group is gone before its PID may be forgotten. */
export async function waitForShutdown(probe, limits = PRIVATE_SERVER_LIMITS) {
  for (let attempt = 1; attempt <= limits.shutdownAttempts; attempt += 1) {
    if (await probe()) return lifecycleRecord("stopped", { attempt });
    if (attempt < limits.shutdownAttempts) await delay(limits.shutdownIntervalMs);
  }
  return lifecycleRecord("cleanup-failed", {
    attempts: limits.shutdownAttempts,
    reason: "shutdown-timeout",
    timeoutMs: limits.shutdownTimeoutMs,
  });
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

/** Maps ignored launcher text to a fixed public code without returning any launcher content. */
export function classifyLauncherFailure(value) {
  if (typeof value !== "string" || value.length === 0) return "health-timeout";
  if (/assetdir/i.test(value)) return "asset-directory-unavailable";
  if (/\.screepsrc/i.test(value)) return "configuration-file-unavailable";
  if (/option .* not defined/i.test(value)) return "required-launch-option-missing";
  if (/steam|authenticat/i.test(value)) return "steam-authentication";
  if (/EADDRINUSE|address already in use/i.test(value)) return "port-unavailable";
  return "launcher-exited";
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
