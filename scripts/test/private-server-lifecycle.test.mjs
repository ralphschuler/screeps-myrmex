import { describe, expect, it } from "vitest";
import {
  lifecyclePaths,
  lifecycleRecord,
  parseLifecycleArguments,
  redactLifecycleError,
  waitForHealth,
} from "../lib/private-server-lifecycle.mjs";

describe("private-server lifecycle", () => {
  it("uses a pinned runtime and rejects unsafe lifecycle arguments", () => {
    expect(lifecycleRecord("healthy")).toEqual({ kind: "healthy", runtime: "screeps@4.3.0" });
    expect(parseLifecycleArguments(["start", "--state-directory", ".private/state"])).toEqual({
      command: "start",
      stateDirectory: ".private/state",
    });
    expect(() => parseLifecycleArguments(["start", "--password", "secret"])).toThrow(
      "Unsupported private-server option",
    );
    expect(() => lifecyclePaths("/work/repo", "../outside")).toThrow("inside the checkout");
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
});
