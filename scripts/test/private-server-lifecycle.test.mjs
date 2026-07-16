import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  PRIVATE_SERVER_LIMITS,
  PRIVATE_SERVER_NODE_VERSION,
  lifecyclePaths,
  classifyLauncherFailure,
  lifecycleRecord,
  parseLifecycleArguments,
  prepareLauncherLog,
  privateServerChildEnvironment,
  privateServerExistingProcessAction,
  privateServerLauncherInvocation,
  privateServerLifecycleSucceeded,
  privateServerNodeSupported,
  privateServerNpmInvocation,
  privateServerProvisioningKey,
  probePrivateServerPort,
  privateServerReadinessObservation,
  privateServerStartPreflight,
  redactLifecycleError,
  scrubProvisionedConfig,
  waitForHealth,
  waitForPrivateServerReadiness,
  waitForShutdown,
} from "../lib/private-server-lifecycle.mjs";

describe("private-server lifecycle", () => {
  it("uses a pinned runtime and rejects unsafe lifecycle arguments", () => {
    expect(lifecycleRecord("healthy")).toEqual({ kind: "healthy", runtime: "screeps@4.3.0" });
    expect(privateServerLifecycleSucceeded("started")).toBe(true);
    expect(privateServerLifecycleSucceeded("already-running")).toBe(false);
    expect(privateServerLifecycleSucceeded("startup-failed")).toBe(false);
    expect(parseLifecycleArguments(["start", "--state-directory", ".private/state"])).toEqual({
      command: "start",
      fixtureScenarioId: null,
      stateDirectory: ".private/state",
    });
    expect(parseLifecycleArguments(["provision"])).toEqual({
      command: "provision",
      fixtureScenarioId: null,
      stateDirectory: ".myrmex-private-server",
    });
    expect(
      parseLifecycleArguments(["start", "--fixture-scenario", "zero-creep-recovery"]),
    ).toMatchObject({
      fixtureScenarioId: "zero-creep-recovery",
    });
    expect(() =>
      parseLifecycleArguments(["start", "--fixture-definition", ".state/definition.json"]),
    ).toThrow("Unsupported private-server option");
    expect(() => parseLifecycleArguments(["start", "--fixture-scenario", "../escape"])).toThrow(
      "safe scenario id",
    );
    expect(() => parseLifecycleArguments(["start", "--password", "secret"])).toThrow(
      "Unsupported private-server option",
    );
    expect(() => lifecyclePaths("/work/repo", "../outside")).toThrow("inside the checkout");
  });

  it("accepts a runtime-only provisioning key and scrubs it from initialized state", () => {
    expect(privateServerProvisioningKey("12345678")).toBe("12345678");
    expect(privateServerProvisioningKey("secret\nvalue")).toBeNull();
    expect(
      scrubProvisionedConfig("assetdir = assets\nsteam_api_key = secret-value\nport = 21025\n"),
    ).toBe("assetdir = assets\nport = 21025\n");
  });

  it("pins Node 22 and removes the Steam key from every child environment", () => {
    expect(PRIVATE_SERVER_NODE_VERSION).toBe("22.22.1");
    expect(privateServerNodeSupported("22.9.0")).toBe(true);
    expect(privateServerNodeSupported("22.22.1")).toBe(true);
    for (const version of ["22.8.9", "23.0.0", "24.18.0", "22", "invalid"]) {
      expect(privateServerNodeSupported(version)).toBe(false);
    }
    const source = { PATH: "/runtime/bin", SCREEPS_STEAM_API_KEY: "runtime-secret" };
    const child = privateServerChildEnvironment(source, {
      MYRMEX_PRIVATE_SERVER_FIXTURE_ID: "cold-boot",
    });
    expect(child).toEqual({
      PATH: "/runtime/bin",
      MYRMEX_PRIVATE_SERVER_FIXTURE_ID: "cold-boot",
    });
    expect(source.SCREEPS_STEAM_API_KEY).toBe("runtime-secret");
    expect(
      privateServerLauncherInvocation("/node22/bin/node", "/runtime/screeps.js", ["start"]),
    ).toEqual({
      args: ["/runtime/screeps.js", "start"],
      command: "/node22/bin/node",
    });
    expect(() => privateServerLauncherInvocation("", "/runtime/screeps.js", [])).toThrow("invalid");
    expect(privateServerNpmInvocation("/node22/bin/node", ["ci"])).toEqual({
      args: ["/node22/lib/node_modules/npm/bin/npm-cli.js", "ci"],
      command: "/node22/bin/node",
    });
    expect(privateServerExistingProcessAction("healthy", null)).toBe("reject");
    expect(privateServerExistingProcessAction("health-timeout", "storage-not-ready")).toBe(
      "reject",
    );
    expect(privateServerExistingProcessAction("health-timeout", "launcher-exited")).toBe("discard");
  });

  it("keeps existing-process recovery, fresh readiness, and teardown inside the startup budget", () => {
    const oneProbe =
      PRIVATE_SERVER_LIMITS.healthTcpProbeTimeoutMs * 2 +
      PRIVATE_SERVER_LIMITS.healthCliProbeTimeoutMs;
    const worstCase =
      oneProbe * (PRIVATE_SERVER_LIMITS.healthAttempts + 1) +
      PRIVATE_SERVER_LIMITS.healthIntervalMs * (PRIVATE_SERVER_LIMITS.healthAttempts - 1) +
      PRIVATE_SERVER_LIMITS.shutdownTimeoutMs;
    expect(worstCase).toBe(53_500);
    expect(worstCase).toBeLessThanOrEqual(PRIVATE_SERVER_LIMITS.startupTimeoutMs);
  });

  it("rejects an unverified live PID before fixture preparation can write", async () => {
    const calls = [];
    await expect(
      privateServerStartPreflight({
        discardPid: async () => calls.push("discard"),
        existingPid: 42,
        fixtureScenarioId: "cold-boot",
        prepareFixture: async () => calls.push("prepare"),
        probeExisting: async () => (calls.push("probe"), lifecycleRecord("healthy")),
      }),
    ).resolves.toEqual({ kind: "reject" });
    expect(calls).toEqual(["probe"]);

    calls.length = 0;
    await expect(
      privateServerStartPreflight({
        discardPid: async () => calls.push("discard"),
        existingPid: 42,
        fixtureScenarioId: "cold-boot",
        prepareFixture: async () => calls.push("prepare"),
        probeExisting: async () => (
          calls.push("probe"),
          lifecycleRecord("health-timeout", { reason: "launcher-exited" })
        ),
      }),
    ).resolves.toEqual({ kind: "ready" });
    expect(calls).toEqual(["probe", "discard", "prepare"]);
  });

  it("bounds health polling and sanitizes lifecycle failure records", async () => {
    let attempts = 0;
    const timeout = await waitForHealth(
      async () => {
        attempts += 1;
        return false;
      },
      { healthAttempts: 3, healthIntervalMs: 0 },
    );
    expect(timeout).toEqual({ kind: "health-timeout", runtime: "screeps@4.3.0", attempts: 3 });
    expect(attempts).toBe(3);
    expect(redactLifecycleError(new Error("token=abc\npassword=xyz"))).toBe(
      "token=[redacted] password=[redacted]",
    );
  });

  it("probes process, game port, CLI port, and storage in order", async () => {
    const calls = [];
    const observation = await privateServerReadinessObservation({
      processStopped: async () => (calls.push("process"), false),
      gamePort: async () => (calls.push("game"), true),
      cliPort: async () => (calls.push("cli"), true),
      storage: async () => (calls.push("storage"), { ready: true, reason: null }),
    });
    expect(observation).toEqual({ ready: true, reason: null });
    expect(calls).toEqual(["process", "game", "cli", "storage"]);

    calls.length = 0;
    await expect(
      privateServerReadinessObservation({
        processStopped: async () => (calls.push("process"), false),
        gamePort: async () => (calls.push("game"), false),
        cliPort: async () => (calls.push("cli"), true),
        storage: async () => (calls.push("storage"), { ready: true, reason: null }),
      }),
    ).resolves.toEqual({ ready: false, reason: "game-port-unavailable" });
    expect(calls).toEqual(["process", "game"]);

    calls.length = 0;
    await expect(
      privateServerReadinessObservation({
        processStopped: async () => (calls.push("process"), true),
        gamePort: async () => (calls.push("game"), true),
        cliPort: async () => (calls.push("cli"), true),
        storage: async () => (calls.push("storage"), { ready: true, reason: null }),
      }),
    ).resolves.toEqual({ ready: false, reason: "launcher-exited", terminal: true });
    expect(calls).toEqual(["process"]);
  });

  it("closes successful listener probes gracefully and destroys failed probes", async () => {
    const clientSockets = [];
    const peers = [];
    let acceptPeer = () => undefined;
    const server = createServer((socket) => {
      let resolveClosed;
      const peer = {
        closed: new Promise((resolve) => {
          resolveClosed = resolve;
        }),
        ended: false,
        errors: [],
      };
      peers.push(peer);
      acceptPeer(peer);
      const lines = createInterface({ input: socket });
      lines.once("error", (error) => peer.errors.push(error.code ?? "readline-error"));
      socket.once("error", (error) => peer.errors.push(error.code ?? "socket-error"));
      socket.once("end", () => {
        peer.ended = true;
      });
      socket.once("close", () => {
        resolveClosed();
      });
      socket.write("< \r\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listener is unavailable");

    for (let index = 0; index < 2; index += 1) {
      const accepted = new Promise((resolve) => {
        acceptPeer = resolve;
      });
      await expect(
        probePrivateServerPort(address.port, 250, (options) => {
          const socket = createConnection(options);
          clientSockets.push(socket);
          return socket;
        }),
      ).resolves.toBe(true);
      const peer = await accepted;
      await peer.closed;
    }
    await new Promise((resolve) => server.close(resolve));
    expect(peers.map(({ ended, errors }) => ({ ended, errors }))).toEqual([
      { ended: true, errors: [] },
      { ended: true, errors: [] },
    ]);
    expect(
      clientSockets.map(({ destroyed, readableLength }) => ({ destroyed, readableLength })),
    ).toEqual([
      { destroyed: true, readableLength: 0 },
      { destroyed: true, readableLength: 0 },
    ]);
    await expect(probePrivateServerPort(address.port, 250)).resolves.toBe(false);

    const timeoutSocket = new EventEmitter();
    timeoutSocket.destroy = vi.fn();
    timeoutSocket.end = vi.fn();
    timeoutSocket.resume = vi.fn();
    await expect(
      probePrivateServerPort(21026, 5, () => {
        queueMicrotask(() => timeoutSocket.emit("connect"));
        return timeoutSocket;
      }),
    ).resolves.toBe(false);
    expect(timeoutSocket.destroy).toHaveBeenCalledOnce();
    expect(timeoutSocket.end).toHaveBeenCalledOnce();
    expect(timeoutSocket.resume).toHaveBeenCalledOnce();
  });

  it("retains bounded readiness reasons, recovers, and exits early for a dead launcher", async () => {
    const observations = [
      { ready: false, reason: "game-port-unavailable" },
      { ready: false, reason: "cli-port-unavailable" },
      { ready: true, reason: null },
    ];
    await expect(
      waitForPrivateServerReadiness(async () => observations.shift(), {
        healthAttempts: 3,
        healthIntervalMs: 0,
      }),
    ).resolves.toEqual({ attempt: 3, kind: "healthy", runtime: "screeps@4.3.0" });

    await expect(
      waitForPrivateServerReadiness(async () => ({ ready: false, reason: "storage-not-ready" }), {
        healthAttempts: 2,
        healthIntervalMs: 0,
      }),
    ).resolves.toEqual({
      attempts: 2,
      kind: "health-timeout",
      reason: "storage-not-ready",
      runtime: "screeps@4.3.0",
    });

    let attempts = 0;
    await expect(
      waitForPrivateServerReadiness(
        async () => {
          attempts += 1;
          return { ready: false, reason: "launcher-exited", terminal: true };
        },
        { healthAttempts: 40, healthIntervalMs: 0 },
      ),
    ).resolves.toEqual({
      attempt: 1,
      kind: "health-timeout",
      reason: "launcher-exited",
      runtime: "screeps@4.3.0",
    });
    expect(attempts).toBe(1);
  });

  it("bounds process-group shutdown before clearing lifecycle state", async () => {
    let attempts = 0;
    const stopped = await waitForShutdown(
      async () => {
        attempts += 1;
        return attempts === 2;
      },
      { shutdownAttempts: 3, shutdownIntervalMs: 0, shutdownTimeoutMs: 5 },
    );
    expect(stopped).toEqual({
      attempt: 2,
      kind: "stopped",
      runtime: "screeps@4.3.0",
    });
    await expect(
      waitForShutdown(async () => false, {
        shutdownAttempts: 2,
        shutdownIntervalMs: 0,
        shutdownTimeoutMs: 5,
      }),
    ).resolves.toEqual({
      attempts: 2,
      kind: "cleanup-failed",
      reason: "shutdown-timeout",
      runtime: "screeps@4.3.0",
      timeoutMs: 5,
    });
  });

  it("exposes only fixed launcher failure codes", () => {
    expect(classifyLauncherFailure("Error: `assetdir` option is not defined!")).toBe(
      "asset-directory-unavailable",
    );
    expect(classifyLauncherFailure("Warning: file .screepsrc not found")).toBe(
      "configuration-file-unavailable",
    );
    expect(classifyLauncherFailure("`db` option is not defined!")).toBe(
      "required-launch-option-missing",
    );
    expect(classifyLauncherFailure("Steam authentication rejected")).toBe("steam-authentication");
    expect(classifyLauncherFailure("listen EADDRINUSE")).toBe("port-unavailable");
    expect(classifyLauncherFailure("unexpected private text")).toBe("launcher-exited");
    expect(classifyLauncherFailure("")).toBe("health-timeout");
  });

  it("clears stale launcher diagnostics before classifying a new start attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "myrmex-private-server-"));
    const paths = lifecyclePaths(root, ".state");
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.log, "Error: `assetdir` option is not defined!", "utf8");

    await prepareLauncherLog(paths);

    expect(await readFile(paths.log, "utf8")).toBe("");
    expect(classifyLauncherFailure("new process exited")).toBe("launcher-exited");
  });

  it("rejects a symlinked fixture module state before starting the launcher", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "myrmex-private-server-"));
    const outside = await mkdtemp(join(tmpdir(), "myrmex-private-server-outside-"));
    await mkdir(join(outside, "fixtures"), { recursive: true });
    await writeFile(
      join(outside, "fixtures/mods.json"),
      JSON.stringify({ mods: [join(outside, "arbitrary.cjs")] }),
      "utf8",
    );
    await symlink(outside, join(checkout, ".private-state"), "dir");

    const result = await executeLifecycle(checkout, [
      "start",
      "--state-directory",
      ".private-state",
      "--fixture-scenario",
      "hostile-reset-v1",
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      kind: "startup-failed",
      reason: "fixture-module-state-invalid",
    });
  });
});

function executeLifecycle(commandCwd, args) {
  const entry = join(process.cwd(), "scripts/private-server.mjs");
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: commandCwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output: output.trim() }));
  });
}
