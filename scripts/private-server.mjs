import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { createConnection } from "node:net";
import { cwd } from "node:process";
import {
  PRIVATE_SERVER_LIMITS,
  clearPid,
  lifecyclePaths,
  lifecycleRecord,
  parseLifecycleArguments,
  readPid,
  redactLifecycleError,
  waitForHealth,
  writePid,
} from "./lib/private-server-lifecycle.mjs";

const options = parseLifecycleArguments(process.argv.slice(2));
const paths = lifecyclePaths(cwd(), options.stateDirectory);
const runtimeDirectory = `${cwd()}/integration/private-server`;

try {
  const record = await run(options.command);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (
    record.kind !== "installed" &&
    record.kind !== "initialized" &&
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
      return execute(
        "npm",
        ["exec", "--prefix", runtimeDirectory, "--", "screeps", "init"],
        "initialized",
        paths.root,
      );
    case "start":
      return start();
    case "health":
      return health();
    case "stop":
      return stop();
  }
}

async function start() {
  if (await readPid(paths)) return lifecycleRecord("already-running");
  await mkdir(paths.root, { recursive: true });
  const log = await open(paths.log, "a");
  const child = spawn(
    "npm",
    [
      "exec",
      "--prefix",
      runtimeDirectory,
      "--",
      "screeps",
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
      "--runners_cnt",
      "1",
      "--processors_cnt",
      "1",
    ],
    { cwd: paths.root, detached: true, stdio: ["ignore", log.fd, log.fd] },
  );
  await log.close();
  child.unref();
  if (child.pid === undefined) return lifecycleRecord("startup-failed");
  await writePid(paths, child.pid);
  const result = await health();
  if (result.kind === "healthy") return lifecycleRecord("started", { pid: child.pid });
  await stop();
  return lifecycleRecord("startup-timeout", { timeoutMs: PRIVATE_SERVER_LIMITS.startupTimeoutMs });
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
