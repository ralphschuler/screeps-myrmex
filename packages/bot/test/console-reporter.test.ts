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

  it("renders deterministic transitions off heartbeat before applying shared caps", () => {
    const base = runTick({ game: game(101), memory: {} as Memory }).reporterStatus;
    const status = {
      ...base,
      transitions: [
        {
          category: "signal" as const,
          kind: "first" as const,
          fingerprint: "reporter-transition:deadbeef",
          count: 1,
          reasonCode: "unexpected-exception",
        },
        {
          category: "signal" as const,
          kind: "resolved" as const,
          fingerprint: "reporter-transition:cafebabe",
          count: 2,
          reasonCode: "unexpected-exception",
        },
      ],
    };
    const policy = {
      ...buildRuntimeConfig().policy.reporter,
      heartbeatIntervalTicks: 10,
      maximumLinesPerTick: 1,
    };
    const reporter = new ConsoleReporter();
    const lines = reporter.report(status, policy, { log: vi.fn() });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reporter signal kind=first");
    expect(lines[0]).toContain("[WARN]");
    expect(reporter.report(status, policy, { log: vi.fn() })).toEqual(lines);
    expect(
      reporter.report(
        status,
        { ...policy, maximumBytesPerTick: (lines[0]?.length ?? 0) - 1 },
        { log: vi.fn() },
      ),
    ).toEqual([]);
  });

  it("separates the representative recovery blocker from bounded action details", () => {
    const base = runTick({ game: game(101), memory: {} as Memory }).reporterStatus;
    const status = {
      ...base,
      recovery: { ...base.recovery, required: true },
      blockers: [
        {
          domain: "colony",
          entityRef: "budget:deadbeef",
          status: "denied",
          reasonCode: "posture-preempted",
        },
        {
          domain: "action",
          entityRef: "transfer:feedface",
          status: "rejected",
          reasonCode: "target-out-of-range",
        },
      ],
      transitions: [
        {
          category: "recovery" as const,
          kind: "stuck" as const,
          owner: "colony" as const,
          blockerReasonCode: "posture-preempted",
          blockerRef: "budget:deadbeef",
          lastProgressTick: 76,
          reminderAtTick: 101,
          reasonCode: "recovery-progress-unchanged",
        },
      ],
    } as typeof base;
    const lines = new ConsoleReporter().report(
      status,
      { ...buildRuntimeConfig().policy.reporter, heartbeatIntervalTicks: 10 },
      { log: vi.fn() },
    );

    expect(lines.join("\n")).toContain("blockerReason=posture-preempted");
    expect(lines.join("\n")).toContain(
      "blockerDetails=representative:posture-preempted other=action:target-out-of-range",
    );
    expect(lines.join("\n")).not.toContain("transfer:feedface");
  });

  it("ignores unknown transition fields without enumerating them and contains renderer faults", () => {
    const base = runTick({ game: game(101), memory: {} as Memory }).reporterStatus;
    const hostile = {
      ...base,
      transitions: [
        new Proxy(
          {
            category: "signal",
            kind: "first",
            fingerprint: "reporter-transition:deadbeef",
            count: 1,
            reasonCode: "unexpected-exception",
            rawPayload: "raw-player-W9N9",
          },
          {
            ownKeys: () => {
              throw new Error("must not enumerate hostile transition fields");
            },
          },
        ),
      ],
    } as unknown as typeof base;
    const hostileLines = new ConsoleReporter().report(
      hostile,
      { ...buildRuntimeConfig().policy.reporter, heartbeatIntervalTicks: 10 },
      { log: vi.fn() },
    );
    expect(hostileLines).toHaveLength(1);
    expect(hostileLines[0]).toContain("reporter signal kind=first");
    expect(hostileLines[0]).not.toContain("raw-player-W9N9");

    const throwing = Object.create(base) as typeof base;
    Object.defineProperty(throwing, "transitions", {
      get: () => {
        throw new Error("renderer getter");
      },
    });
    expect(
      new ConsoleReporter().report(throwing, buildRuntimeConfig().policy.reporter, {
        log: vi.fn(),
      }),
    ).toEqual([]);
  });

  it("rejects oversized transitions before traversal and does not invoke accessors", () => {
    const base = runTick({ game: game(101), memory: {} as Memory }).reporterStatus;
    const policy = buildRuntimeConfig().policy.reporter;
    let visited = 0;
    const oversized = new Array<unknown>(2_000);
    Object.defineProperty(oversized, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        visited += 1;
        throw new Error("must not render oversized input");
      },
    });
    const oversizedStatus = { ...base, transitions: oversized } as unknown as typeof base;

    expect(new ConsoleReporter().report(oversizedStatus, policy, { log: vi.fn() })).toEqual([]);
    expect(visited).toBe(0);

    const accessor = {
      kind: "first",
      fingerprint: "reporter-transition:deadbeef",
      count: 1,
      reasonCode: "unexpected-exception",
    };
    Object.defineProperty(accessor, "category", {
      enumerable: true,
      get: () => {
        visited += 1;
        return "signal";
      },
    });
    const accessorStatus = { ...base, transitions: [accessor] } as unknown as typeof base;
    expect(new ConsoleReporter().report(accessorStatus, policy, { log: vi.fn() })).toEqual([]);
    expect(visited).toBe(0);
  });

  it("fails hostile numeric fields closed and bounds overflow without raw rendering", () => {
    const base = runTick({ game: game(100), memory: {} as Memory }).reporterStatus;
    const status = {
      ...base,
      runtime: {
        ...base.runtime,
        cpuMode: "\u001b[2J raw-player-mode",
        cpuLimit: Number.MAX_SAFE_INTEGER,
        cpuUsedMilli: "raw-player-cpu",
      },
      recovery: { ...base.recovery, spawnDemand: "raw-player-demand" },
      transitions: [
        {
          category: "signal",
          kind: "first",
          fingerprint: "reporter-transition:deadbeef",
          count: Number.MAX_SAFE_INTEGER,
          reasonCode: "unexpected-exception",
        },
      ],
    } as unknown as typeof base;
    const lines = new ConsoleReporter().report(status, buildRuntimeConfig().policy.reporter, {
      log: vi.fn(),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mode=invalid-code");
    expect(lines[0]).toContain(`cpu=0/${String(Number.MAX_SAFE_INTEGER)}`);
    expect(lines[0]).toContain("spawnDemand=0");
    expect(lines.join("\n")).not.toContain("raw-player");
    expect(lines.join("\n")).not.toContain("\u001b");
  });

  it("rejects oversized diagnostic categories before visiting their entries", () => {
    const base = runTick({ game: game(100), memory: {} as Memory }).reporterStatus;
    let visited = 0;
    const categories = new Array<unknown>(2_000);
    Object.defineProperty(categories, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        visited += 1;
        throw new Error("must not render oversized diagnostics");
      },
    });
    const status = {
      ...base,
      diagnostic: { level: "trace", categories, expiresAtTick: 101 },
    } as unknown as typeof base;
    const lines = new ConsoleReporter().report(status, buildRuntimeConfig().policy.reporter, {
      log: vi.fn(),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("diagnostic");
    expect(visited).toBe(0);
  });

  it("does not render diagnostics at their exact expiry tick", () => {
    const base = runTick({ game: game(100), memory: {} as Memory }).reporterStatus;
    const status = {
      ...base,
      diagnostic: { level: "trace", categories: ["faults"], expiresAtTick: 100 },
    } as const;
    const lines = new ConsoleReporter().report(status, buildRuntimeConfig().policy.reporter, {
      log: vi.fn(),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("diagnostic");
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
