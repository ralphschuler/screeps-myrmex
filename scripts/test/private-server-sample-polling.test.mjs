import { describe, expect, it } from "vitest";
import { waitForPrivateServerSample } from "../lib/private-server-sample-polling.mjs";

describe("private-server sample polling", () => {
  it("retries only transient receipts until a controlled sample reaches its deadline", async () => {
    const values = [new Error("not ready"), { tick: 3 }, { tick: 10 }];
    const result = await waitForPrivateServerSample({
      delay: async () => undefined,
      isTransientError: (error) => error instanceof Error && error.message === "not ready",
      now: clock(),
      sample: async () => {
        const value = values.shift();
        if (value instanceof Error) throw value;
        return value;
      },
      tickDeadline: 10,
    });
    expect(result).toEqual({ kind: "sample", result: { tick: 10 } });
  });

  it("distinguishes a never-ready sample from a tick deadline timeout", async () => {
    const notReady = await waitForPrivateServerSample({
      delay: async () => undefined,
      isTransientError: () => true,
      now: clock(),
      sample: async () => {
        throw new Error("not ready");
      },
      tickDeadline: 10,
      timeoutMs: 1,
    });
    expect(notReady).toEqual({ kind: "not-ready" });
  });
});

function clock() {
  let value = 0;
  return () => value++;
}
