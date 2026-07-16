import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { cwd, env, execPath, versions } from "node:process";
import { probePrivateServerReadiness } from "./lib/private-server-cli.mjs";
import {
  PRIVATE_SERVER_LIMITS,
  classifyLauncherFailure,
  clearPid,
  lifecyclePaths,
  lifecycleRecord,
  parseLifecycleArguments,
  prepareLauncherLog,
  privateServerChildEnvironment,
  privateServerLauncherInvocation,
  privateServerLifecycleSucceeded,
  privateServerNodeSupported,
  privateServerNpmInvocation,
  privateServerProvisioningKey,
  probePrivateServerPort,
  privateServerReadinessObservation,
  privateServerStartPreflight,
  readPid,
  redactLifecycleError,
  scrubProvisionedConfig,
  waitForPrivateServerReadiness,
  waitForShutdown,
  writePid,
} from "./lib/private-server-lifecycle.mjs";
import {
  preparePrivateServerFixtureModuleState,
  validatePrivateServerFixtureModuleState,
  validatePrivateServerFixtureStatePath,
} from "./lib/private-server-fixture-state.mjs";

const options = parseLifecycleArguments(process.argv.slice(2));
const paths = lifecyclePaths(cwd(), options.stateDirectory);
const runtimeDirectory = `${cwd()}/integration/private-server`;
const launcherExecutable = `${runtimeDirectory}/node_modules/.bin/screeps`;
const fixtureDefinition =
  options.fixtureScenarioId === null ? null : `${paths.root}/fixtures/definition.json`;

try {
  const record = await run(options.command);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (!privateServerLifecycleSucceeded(record.kind)) process.exitCode = 1;
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(lifecycleRecord("lifecycle-failure", { reason: redactLifecycleError(error) }))}\n`,
  );
  process.exitCode = 1;
}

async function run(command) {
  if (command !== "start" && command !== "stop" && !privateServerNodeSupported(versions.node)) {
    return lifecycleRecord("startup-failed", { reason: "unsupported-node-runtime" });
  }
  switch (command) {
    case "install":
      return executeNpm(["ci", "--prefix", runtimeDirectory], "installed");
    case "init":
      await mkdir(paths.root, { recursive: true });
      return executeLauncher(["init"], "initialized", paths.root);
    case "provision":
      return provision();
    case "start":
      return start();
    case "health":
      return health();
    case "stop":
      return stop();
  }
}

async function provision() {
  const key = privateServerProvisioningKey(env.SCREEPS_STEAM_API_KEY);
  if (key === null) return lifecycleRecord("provisioning-required");
  await mkdir(paths.root, { recursive: true });
  const launcher = privateServerLauncherInvocation(execPath, launcherExecutable, ["init"]);
  const result = await executeWithInput(launcher.command, launcher.args, key, paths.root);
  if (result.kind !== "initialized") return result;
  const configPath = `${paths.root}/.screepsrc`;
  await writeFile(configPath, scrubProvisionedConfig(await readFile(configPath, "utf8")), "utf8");
  return lifecycleRecord("provisioned");
}

async function start() {
  if (fixtureDefinition !== null) {
    try {
      await validatePrivateServerFixtureStatePath({
        checkout: cwd(),
        stateDirectory: options.stateDirectory,
      });
    } catch {
      return lifecycleRecord("startup-failed", { reason: "fixture-module-state-invalid" });
    }
  }
  if (!privateServerNodeSupported(versions.node)) {
    return lifecycleRecord("startup-failed", { reason: "unsupported-node-runtime" });
  }
  const existingPid = await readPid(paths);
  let preflight;
  try {
    preflight = await privateServerStartPreflight({
      discardPid: () => clearPid(paths),
      existingPid,
      fixtureScenarioId: options.fixtureScenarioId,
      prepareFixture: async () => {
        await preparePrivateServerFixtureModuleState({
          checkout: cwd(),
          stateDirectory: options.stateDirectory,
        });
        await validatePrivateServerFixtureModuleState({
          checkout: cwd(),
          stateDirectory: options.stateDirectory,
        });
      },
      probeExisting: () =>
        health({
          ...PRIVATE_SERVER_LIMITS,
          healthAttempts: 1,
          healthIntervalMs: 0,
        }),
    });
  } catch {
    return lifecycleRecord("startup-failed", { reason: "fixture-module-state-invalid" });
  }
  if (preflight.kind === "reject") {
    return lifecycleRecord("startup-failed", {
      reason: "existing-process-unverified",
      timeoutMs: PRIVATE_SERVER_LIMITS.startupTimeoutMs,
    });
  }
  await mkdir(paths.root, { recursive: true });
  await prepareLauncherLog(paths);
  const log = await open(paths.log, "a");
  const provisioningKey = privateServerProvisioningKey(env.SCREEPS_STEAM_API_KEY);
  const childEnvironment = privateServerChildEnvironment(
    env,
    fixtureDefinition === null
      ? {}
      : {
          MYRMEX_PRIVATE_SERVER_FIXTURE: fixtureDefinition,
          MYRMEX_PRIVATE_SERVER_FIXTURE_ID: options.fixtureScenarioId,
        },
  );
  const launcher = privateServerLauncherInvocation(execPath, launcherExecutable, [
    "start",
    "--db",
    `${paths.root}/db.json`,
    "--logdir",
    paths.root,
    "--assetdir",
    `${paths.root}/assets`,
    "--host",
    "127.0.0.1",
    "--port",
    "21025",
    "--cli_host",
    "127.0.0.1",
    "--cli_port",
    "21026",
    "--runner_threads",
    "1",
    "--processors_cnt",
    "1",
    ...(fixtureDefinition === null ? [] : ["--modfile", `${paths.root}/fixtures/mods.json`]),
    ...(provisioningKey === null ? [] : ["--steam_api_key", provisioningKey]),
  ]);
  const child = spawn(launcher.command, launcher.args, {
    cwd: paths.root,
    detached: true,
    env: childEnvironment,
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  child.unref();
  if (child.pid === undefined) return lifecycleRecord("startup-failed");
  await writePid(paths, child.pid);
  const result = await health();
  if (result.kind === "healthy") return lifecycleRecord("started", { pid: child.pid });
  const readinessReason =
    result.reason === "launcher-exited"
      ? classifyLauncherFailure(await readLauncherLog())
      : result.reason;
  const cleanup = await stop();
  if (cleanup.kind !== "stopped") return cleanup;
  return lifecycleRecord("startup-failed", {
    reason: readinessReason ?? classifyLauncherFailure(await readLauncherLog()),
    timeoutMs: PRIVATE_SERVER_LIMITS.startupTimeoutMs,
  });
}

async function readLauncherLog() {
  try {
    return await readFile(paths.log, "utf8");
  } catch {
    return "";
  }
}

async function executeWithInput(command, args, input, commandCwd) {
  return new Promise((resolveRecord) => {
    const child = spawn(command, args, {
      cwd: commandCwd,
      env: privateServerChildEnvironment(env),
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", (error) =>
      resolveRecord(lifecycleRecord("startup-failed", { reason: redactLifecycleError(error) })),
    );
    child.once("exit", (code) =>
      resolveRecord(
        lifecycleRecord(code === 0 ? "initialized" : "startup-failed", { code: code ?? -1 }),
      ),
    );
    child.stdin.end(`${input}\n`);
  });
}

async function health(limits = PRIVATE_SERVER_LIMITS) {
  const pid = await readPid(paths);
  if (pid === null) return lifecycleRecord("not-running");
  return waitForPrivateServerReadiness(
    () =>
      privateServerReadinessObservation({
        cliPort: () => probePrivateServerPort(21026, limits.healthTcpProbeTimeoutMs),
        gamePort: () => probePrivateServerPort(21025, limits.healthTcpProbeTimeoutMs),
        processStopped: () => processGroupStopped(pid),
        storage: () => probePrivateServerReadiness({ timeoutMs: limits.healthCliProbeTimeoutMs }),
      }),
    limits,
  );
}

async function stop() {
  const pid = await readPid(paths);
  if (pid === null) return lifecycleRecord("stopped");
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      await clearPid(paths);
      return lifecycleRecord("stopped");
    }
    return lifecycleRecord("cleanup-failed", { reason: redactLifecycleError(error) });
  }
  const result = await waitForShutdown(() => processGroupStopped(pid));
  if (result.kind !== "stopped") return result;
  await clearPid(paths);
  return lifecycleRecord("stopped");
}

function processGroupStopped(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}

async function execute(command, args, successKind, commandCwd = cwd()) {
  return new Promise((resolveRecord) => {
    const child = spawn(command, args, {
      cwd: commandCwd,
      env: privateServerChildEnvironment(env),
      stdio: "ignore",
    });
    child.once("error", (error) =>
      resolveRecord(lifecycleRecord("startup-failed", { reason: redactLifecycleError(error) })),
    );
    child.once("exit", (code) =>
      resolveRecord(
        lifecycleRecord(code === 0 ? successKind : "startup-failed", { code: code ?? -1 }),
      ),
    );
  });
}

function executeLauncher(args, successKind, commandCwd) {
  const launcher = privateServerLauncherInvocation(execPath, launcherExecutable, args);
  return execute(launcher.command, launcher.args, successKind, commandCwd);
}

function executeNpm(args, successKind) {
  const npm = privateServerNpmInvocation(execPath, args);
  return execute(npm.command, npm.args, successKind);
}
