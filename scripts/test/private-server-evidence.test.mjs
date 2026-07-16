import { describe, expect, it } from "vitest";
import {
  createPrivateServerEvidence,
  definePrivateServerManifest,
} from "../lib/private-server-evidence.mjs";

const manifest = {
  id: "cold-boot",
  buildId: "build-123",
  seed: "seed-1",
  tickDeadline: 100,
  injection: "heap-reset",
  assertions: [
    { id: "cpu", minimum: 0, maximum: 20 },
    { id: "ticks", minimum: 1, maximum: 100 },
  ],
};

describe("private-server evidence", () => {
  it("canonicalizes equivalent manifests and redacts bounded artifacts", () => {
    expect(definePrivateServerManifest(manifest).assertions.map(({ id }) => id)).toEqual([
      "cpu",
      "ticks",
    ]);
    const first = createPrivateServerEvidence({
      manifest,
      cleanup: "complete",
      failure: null,
      outcomes: [
        { count: 1, kind: "spawn" },
        { count: 2, kind: "move" },
      ],
      state: [{ memory: "secret=hidden", tick: 1 }],
      logs: ["token=abc W12N34\nconsole output"],
    });
    const reordered = createPrivateServerEvidence({
      manifest: { ...manifest, assertions: [...manifest.assertions].reverse() },
      cleanup: "complete",
      failure: null,
      outcomes: [
        { kind: "move", count: 2 },
        { kind: "spawn", count: 1 },
      ],
      state: [{ tick: 1, memory: "secret=hidden" }],
      logs: ["token=abc W12N34\nconsole output"],
    });
    expect(first).toEqual(reordered);
    expect(JSON.stringify(first)).not.toContain("hidden");
    expect(JSON.stringify(first)).not.toContain("W12N34");
  });

  it("rejects unsafe manifests and unsupported failure evidence", () => {
    expect(() => definePrivateServerManifest({ ...manifest, tickDeadline: 10_001 })).toThrow(
      "tickDeadline",
    );
    expect(() =>
      createPrivateServerEvidence({
        manifest,
        cleanup: "partial",
        failure: { kind: "raw-error" },
        outcomes: [],
        state: [],
        logs: [],
      }),
    ).toThrow("failure kind");
  });

  it("caps multibyte logs by UTF-8 bytes without retaining their raw content", () => {
    const evidence = createPrivateServerEvidence({
      manifest,
      cleanup: "incomplete",
      failure: { kind: "cleanup-failed" },
      outcomes: [],
      state: [],
      logs: ["😀".repeat(200)],
    });
    expect(evidence.logs[0]?.bytes).toBe(512);
    expect(JSON.stringify(evidence)).not.toContain("😀");
    expect(evidence.failure).toEqual({ kind: "cleanup-failed" });
  });
});
