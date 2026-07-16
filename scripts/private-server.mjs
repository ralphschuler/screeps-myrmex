import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { cwd, env } from "node:process";
import {
  PRIVATE_SERVER_LIMITS,
  classifyLauncherFailure,
  clearPid,
  lifecyclePaths,
  lifecycleRecord,
  parseLifecycleArguments,
  privateServerProvisioningKey,
  readPid,
  redactLifecycleError,
  scrubProvisionedConfig,
  waitForHealth,
  writePid,
} from "./lib/private-server-lifecycle.mjs";

const options = parseLifecycleArguments(process.argv.slice(2));
const paths = lifecyclePaths(cwd(), options.stateDirectory);
const runtimeDirectory = `${cwd()}/integration/private-server`;
const launcherExecutable = `${runtimeDirectory}/node_modules/.bin/screeps`;
const fixtureDefinition =
  options.fixtureDefinition === null ? null : `${cwd()}/${options.fixtureDefinition}`;

try {
  const record = await run(options.command);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (
    record.kind !== "installed" &&
    record.kind !== "initialized" &&
    record.kind !== "provisioned" &&
    record.kind !== "healthy" &&
    record.kind !== "stopped"
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(lifecycleRecord("lifecycle-failure", { reason: redactLifecycleError(error) }))}\n`,
  );
  process.exitCode = 1;
}

async function run(command) {
  switch (command) {
    case "install":
      return execute("npm", ["ci", "--prefix", runtimeDirectory], "installed");
    case "init":
      await mkdir(paths.root, { recursive: true });
      return execute(launcherExecutable, ["init"], "initialized", paths.root);
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
  const result = await executeWithInput(launcherExecutable, ["init"], key, paths.root);
  if (result.kind !== "initialized") return result;
  const configPath = `${paths.root}/.screepsrc`;
  await writeFile(configPath, scrubProvisionedConfig(await readFile(configPath, "utf8")), "utf8");
  return lifecycleRecord("provisioned");
}

async function start() {
  if (await readPid(paths)) return lifecycleRecord("already-running");
  await mkdir(paths.root, { recursive: true });
  const log = await open(paths.log, "a");
  const child = spawn(
    launcherExecutable,
    [
      "start",
      "--db",
      `${paths.root}/db.json`,
      "--logdir",
      paths.root,
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
      ...(privateServerProvisioningKey(env.SCREEPS_STEAM_API_KEY) === null
        ? []
        : ["--steam_api_key", env.SCREEPS_STEAM_API_KEY]),
    ],
    {
      cwd: paths.root,
      detached: true,
      env:
        fixtureDefinition === null
          ? undefined
          : { ...env, MYRMEX_PRIVATE_SERVER_FIXTURE: fixtureDefinition },
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  await log.close();
  child.unref();
  if (child.pid === undefined) return lifecycleRecord("startup-failed");
  await writePid(paths, child.pid);
  const result = await health();
  if (result.kind === "healthy") return lifecycleRecord("started", { pid: child.pid });
  await stop();
  return lifecycleRecord("startup-failed", {
    reason: classifyLauncherFailure(await readLauncherLog()),
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
    const child = spawn(command, args, { cwd: commandCwd, stdio: ["pipe", "ignore", "ignore"] });
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

async function health() {
  const pid = await readPid(paths);
  if (pid === null) return lifecycleRecord("not-running");
  return waitForHealth(() => tcpProbe(21025));
}

async function stop() {
  const pid = await readPid(paths);
  if (pid === null) return lifecycleRecord("stopped");
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    await clearPid(paths);
    return lifecycleRecord("cleanup-failed", { reason: redactLifecycleError(error) });
  }
  await clearPid(paths);
  return lifecycleRecord("stopped");
}

async function execute(command, args, successKind, commandCwd = cwd()) {
  return new Promise((resolveRecord) => {
    const child = spawn(command, args, { cwd: commandCwd, stdio: "ignore" });
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

function tcpProbe(port) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", () => resolveProbe(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolveProbe(false);
    });
  });
}
