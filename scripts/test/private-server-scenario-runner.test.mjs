import { describe, expect, it } from "vitest";
import {
  clearPrivateServerScenarioFixture,
  privateServerScenarioMatrix,
  runPrivateServerScenario,
} from "../lib/private-server-scenario-runner.mjs";

const manifest = {
  assertions: [{ id: "owned-creeps", maximum: 2, minimum: 1 }],
  buildId: "bundle-abc123",
  id: "zero-creep-recovery",
  injection: "none",
  seed: "phase1-v1",
  tickDeadline: 10,
};

describe("private-server scenario runner", () => {
  it("removes fixture publication before clearing receipts and attempts every cleanup step", async () => {
    const calls = [];
    await clearPrivateServerScenarioFixture({
      active: true,
      clearReceipts: async () => calls.push("clearReceipts"),
      pause: async () => calls.push("pause"),
      removePublication: async () => calls.push("removePublication"),
    });
    expect(calls).toEqual(["pause", "removePublication", "clearReceipts"]);

    const failureCalls = [];
    await expect(
      clearPrivateServerScenarioFixture({
        active: true,
        clearReceipts: async () => {
          failureCalls.push("clearReceipts");
          throw new Error("receipt failure");
        },
        pause: async () => {
          failureCalls.push("pause");
          throw new Error("pause failure");
        },
        removePublication: async () => {
          failureCalls.push("removePublication");
          throw new Error("publication failure");
        },
      }),
    ).rejects.toThrow("pause failure");
    expect(failureCalls).toEqual(["pause", "removePublication", "clearReceipts"]);
  });

  it("produces canonical successful evidence only after the exact driver sequence", async () => {
    const calls = [];
    const result = await runPrivateServerScenario({ driver: driver(calls), manifest });
    expect(result.ok).toBe(true);
    expect(result.evidence).toMatchObject({ cleanup: "complete", failure: null });
    expect(calls).toEqual([
      "start",
      "pause",
      "reset",
      "pause",
      "bootstrap",
      "deploy",
      "resume",
      "prepareFixture",
      "pause",
      "configureFixture",
      "awaitFixtureReady",
      "resume",
      "observe",
      "clearFixture",
      "stop",
    ]);
  });

  it("classifies assertion, timeout, bot, and cleanup terminal paths", async () => {
    const assertion = await runPrivateServerScenario({
      driver: driver([], { metrics: { "owned-creeps": 0 } }),
      manifest,
    });
    expect(assertion.evidence.failure).toEqual({ kind: "assertion-failed" });
    const timeout = await runPrivateServerScenario({
      driver: driver([], { observeError: namedError("ScenarioTimeoutError") }),
      manifest,
    });
    expect(timeout.evidence.failure).toEqual({ kind: "scenario-timeout" });
    expect(timeout.failureCode).toBeNull();
    const bot = await runPrivateServerScenario({
      driver: driver([], { observeError: namedError("BotExceptionError") }),
      manifest,
    });
    expect(bot.evidence.failure).toEqual({ kind: "bot-exception" });
    const startup = await runPrivateServerScenario({
      driver: driver([], { observeError: namedError("StartupFailure", "port-unavailable") }),
      manifest,
    });
    expect(startup).toMatchObject({ failureCode: "port-unavailable", ok: false });
    const cli = await runPrivateServerScenario({
      driver: driver([], {
        observeError: namedError("CliOperationFailure", "cli-bootstrap-controlled-bot-failed"),
      }),
      manifest,
    });
    expect(cli).toMatchObject({
      evidence: { failure: { kind: "cli-operation-failed" } },
      failureCode: "cli-bootstrap-controlled-bot-failed",
      ok: false,
    });
    const sample = await runPrivateServerScenario({
      driver: driver([], {
        observeError: namedError("CliOperationFailure", "cli-sample-controlled-not-ready"),
      }),
      manifest,
    });
    expect(sample).toMatchObject({
      evidence: { failure: { kind: "cli-operation-failed" } },
      failureCode: "cli-sample-controlled-not-ready",
      ok: false,
    });
    const deployment = await runPrivateServerScenario({
      driver: driver([], {
        observeError: namedError("BundleDeploymentFailure", "bundle-deployment-unacknowledged"),
      }),
      manifest,
    });
    expect(deployment).toMatchObject({
      evidence: { failure: { kind: "bundle-deployment-failed" } },
      failureCode: "bundle-deployment-unacknowledged",
      ok: false,
    });
    const cleanup = await runPrivateServerScenario({
      driver: driver([], { stopError: new Error("cannot stop") }),
      manifest,
    });
    expect(cleanup.evidence.failure).toEqual({ kind: "cleanup-failed" });
    const cleanupCalls = [];
    const fixtureCleanup = await runPrivateServerScenario({
      driver: driver(cleanupCalls, {
        clearFixtureError: namedError("CliOperationFailure", "cli-clear-fixture-failed"),
      }),
      manifest,
    });
    expect(fixtureCleanup).toMatchObject({
      evidence: { failure: { kind: "cleanup-failed" } },
      failureCode: "cli-clear-fixture-failed",
      ok: false,
    });
    expect(cleanupCalls.at(-1)).toBe("stop");
  });

  it("surfaces the cleanup code when both primary execution and cleanup fail", async () => {
    const result = await runPrivateServerScenario({
      driver: driver([], {
        observeError: namedError("CliOperationFailure", "cli-sample-controlled-not-ready"),
        stopError: namedError("StartupFailure", "shutdown-timeout"),
      }),
      manifest,
    });
    expect(result).toMatchObject({
      evidence: {
        cleanup: "incomplete",
        failure: { kind: "cleanup-failed" },
      },
      failureCode: "shutdown-timeout",
      ok: false,
    });
    expect(result.evidence.logs).toHaveLength(2);
  });

  it("attempts terminal cleanup when active readiness fails during startup", async () => {
    const calls = [];
    const result = await runPrivateServerScenario({
      driver: driver(calls, {
        startError: namedError("StartupFailure", "storage-not-ready"),
      }),
      manifest,
    });
    expect(result).toMatchObject({
      evidence: { cleanup: "complete", failure: { kind: "startup-failed" } },
      failureCode: "storage-not-ready",
      ok: false,
    });
    expect(calls).toEqual(["start", "clearFixture", "stop"]);
  });

  it("preserves a partial-start teardown failure as incomplete cleanup", async () => {
    const calls = [];
    const cleanupFailure = namedError("CleanupFailure", "shutdown-timeout");
    const result = await runPrivateServerScenario({
      driver: driver(calls, {
        startError: cleanupFailure,
        stopError: cleanupFailure,
      }),
      manifest,
    });
    expect(result).toMatchObject({
      evidence: { cleanup: "incomplete", failure: { kind: "cleanup-failed" } },
      failureCode: "shutdown-timeout",
      ok: false,
    });
    expect(calls).toEqual(["start", "clearFixture", "stop"]);
  });

  it.each([
    ["CliOperationFailure", "cli-pause-failed", "cli-operation-failed"],
    ["CliOperationFailure", "cli-pause-fixture-clear-failed", "cli-operation-failed"],
    ["CliOperationFailure", "cli-pause-fixture-failed", "cli-operation-failed"],
    ["CliOperationFailure", "cli-pause-fixture-request-failed", "cli-operation-failed"],
    ["CliOperationFailure", "cli-sample-fixture-failed", "cli-operation-failed"],
    ["CliOperationFailure", "cli-sample-fixture-quiescence-failed", "cli-operation-failed"],
    ["StartupFailure", "cli-closed", "startup-failed"],
    ["StartupFailure", "cli-connection-failed", "startup-failed"],
    ["StartupFailure", "cli-port-unavailable", "startup-failed"],
    ["StartupFailure", "cli-timeout", "startup-failed"],
    ["StartupFailure", "existing-process-unverified", "startup-failed"],
    ["StartupFailure", "fixture-definition-rejected", "startup-failed"],
    ["StartupFailure", "fixture-module-state-invalid", "startup-failed"],
    ["StartupFailure", "fixture-ready-timeout", "startup-failed"],
    ["StartupFailure", "fixture-quiescence-rejected", "startup-failed"],
    ["StartupFailure", "fixture-quiescence-timeout", "startup-failed"],
    ["StartupFailure", "game-port-unavailable", "startup-failed"],
    ["StartupFailure", "readiness-receipt-invalid", "startup-failed"],
    ["StartupFailure", "storage-not-ready", "startup-failed"],
    ["StartupFailure", "storage-readiness-rejected", "startup-failed"],
    ["StartupFailure", "unsupported-node-runtime", "startup-failed"],
  ])("preserves the bounded %s code %s", async (name, code, kind) => {
    const result = await runPrivateServerScenario({
      driver: driver([], { observeError: namedError(name, code) }),
      manifest,
    });
    expect(result).toMatchObject({
      evidence: { failure: { kind } },
      failureCode: code,
      ok: false,
    });
  });

  it("keeps the Phase 1 matrix fixed and bounded", () => {
    expect(privateServerScenarioMatrix({ buildId: "bundle-abc123" })).toHaveLength(5);
    expect(() => privateServerScenarioMatrix({ buildId: "not safe!" })).toThrow("safe bounded");
  });
});

function driver(calls, options = {}) {
  const step = (name) => async () => calls.push(name);
  return {
    start: async () => {
      calls.push("start");
      if (options.startError) throw options.startError;
    },
    pause: step("pause"),
    reset: step("reset"),
    bootstrap: step("bootstrap"),
    deploy: step("deploy"),
    configureFixture: step("configureFixture"),
    awaitFixtureReady: step("awaitFixtureReady"),
    resume: step("resume"),
    prepareFixture: step("prepareFixture"),
    observe: async () => {
      calls.push("observe");
      if (options.observeError) throw options.observeError;
      return {
        failure: null,
        logs: [],
        metrics: options.metrics ?? { "owned-creeps": 1 },
        outcomes: [{ metric: "owned-creeps", value: options.metrics?.["owned-creeps"] ?? 1 }],
        state: [{ tick: 1 }],
      };
    },
    clearFixture: async () => {
      calls.push("clearFixture");
      if (options.clearFixtureError) throw options.clearFixtureError;
    },
    stop: async () => {
      calls.push("stop");
      if (options.stopError) throw options.stopError;
    },
  };
}

function namedError(name, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}
