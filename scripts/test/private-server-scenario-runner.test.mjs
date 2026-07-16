import { describe, expect, it } from "vitest";
import {
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
  it("produces canonical successful evidence only after the exact driver sequence", async () => {
    const calls = [];
    const result = await runPrivateServerScenario({ driver: driver(calls), manifest });
    expect(result.ok).toBe(true);
    expect(result.evidence).toMatchObject({ cleanup: "complete", failure: null });
    expect(calls).toEqual([
      "start",
      "pause",
      "reset",
      "bootstrap",
      "deploy",
      "resume",
      "prepareFixture",
      "pause",
      "configureFixture",
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
    const cleanup = await runPrivateServerScenario({
      driver: driver([], { stopError: new Error("cannot stop") }),
      manifest,
    });
    expect(cleanup.evidence.failure).toEqual({ kind: "cleanup-failed" });
  });

  it("keeps the Phase 1 matrix fixed and bounded", () => {
    expect(privateServerScenarioMatrix({ buildId: "bundle-abc123" })).toHaveLength(5);
    expect(() => privateServerScenarioMatrix({ buildId: "not safe!" })).toThrow("safe bounded");
  });
});

function driver(calls, options = {}) {
  const step = (name) => async () => calls.push(name);
  return {
    start: step("start"),
    pause: step("pause"),
    reset: step("reset"),
    bootstrap: step("bootstrap"),
    deploy: step("deploy"),
    configureFixture: step("configureFixture"),
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
    clearFixture: step("clearFixture"),
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
