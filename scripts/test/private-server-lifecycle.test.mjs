import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lifecyclePaths,
  classifyLauncherFailure,
  lifecycleRecord,
  parseLifecycleArguments,
  prepareLauncherLog,
  privateServerProvisioningKey,
  redactLifecycleError,
  scrubProvisionedConfig,
  waitForHealth,
  waitForShutdown,
} from "../lib/private-server-lifecycle.mjs";

describe("private-server lifecycle", () => {
  it("uses a pinned runtime and rejects unsafe lifecycle arguments", () => {
    expect(lifecycleRecord("healthy")).toEqual({ kind: "healthy", runtime: "screeps@4.3.0" });
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
