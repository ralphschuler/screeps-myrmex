import { describe, expect, it, vi } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { ConsoleReporter } from "../src/telemetry/console-reporter";
import { runTick } from "../src/runtime/tick";

describe("ConsoleReporter", () => {
  it("renders only bounded deterministic heartbeat lines", () => {
    const status = runTick({ game: game(100), memory: {} as Memory }).reporterStatus;
    const sink = { log: vi.fn() };
    const policy = { ...buildRuntimeConfig().policy.reporter, heartbeatIntervalTicks: 10 };
    const lines = new ConsoleReporter().report(status, policy, sink);
    expect(lines).toHaveLength(1);
    expect(sink.log).toHaveBeenCalledWith(lines[0]);
    expect(lines[0]).toContain("[MYRMEX][INFO]");
    expect(lines[0]).not.toContain("shard3");
  });

  it("drops over-budget output and isolates sink faults", () => {
    const status = runTick({ game: game(100), memory: {} as Memory }).reporterStatus;
    const base = buildRuntimeConfig().policy.reporter;
    expect(
      new ConsoleReporter().report(status, { ...base, maximumBytesPerTick: 1 }, { log: vi.fn() }),
    ).toEqual([]);
    expect(
      new ConsoleReporter().report(status, base, {
        log: () => {
          throw new Error("sink");
        },
      }),
    ).toEqual([]);
  });

  it("renders only fixed safe diagnostic categories within the existing caps", () => {
    const base = runTick({ game: game(100), memory: {} as Memory }).reporterStatus;
    const status = {
      ...base,
      diagnostic: {
        level: "debug" as const,
        categories: ["recovery", "faults"] as const,
        expiresAtTick: 101,
      },
    };
    const policy = {
      ...buildRuntimeConfig().policy.reporter,
      heartbeatIntervalTicks: 10,
      maximumLinesPerTick: 2,
    };
    const lines = new ConsoleReporter().report(status, policy, { log: vi.fn() });
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("diagnostic recovery");
    expect(lines.join("\n")).not.toContain("diagnostic faults");
    expect(lines.join("\n")).not.toContain("shard3");
  });
});

function game(time: number) {
  return {
    cpu: { bucket: 9000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: {},
    rooms: {},
    shard: { name: "shard3" },
    time,
  };
}
