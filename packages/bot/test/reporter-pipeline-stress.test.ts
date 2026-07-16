import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { runTick } from "../src/runtime/tick";
import { ConsoleReporter } from "../src/telemetry/console-reporter";
import type { ReporterSignal } from "../src/telemetry/reporter-state";
import { projectReporterStatus } from "../src/telemetry/reporter-status";
import { TelemetryService } from "../src/telemetry/service";

describe("reporter pipeline stress", () => {
  it("deduplicates and deterministically bounds thousands of reordered hostile signals", () => {
    const harness = createHarness();
    const repeated = Array.from({ length: 2_000 }, () => hostileSignal(7));
    const equivalent = record(harness, {}, 100, repeated);

    expect(retainedEntries(equivalent.owner)).toHaveLength(1);
    expect(equivalent.telemetry.reporterTransitions).toHaveLength(1);
    expect(equivalent.status.transitions).toHaveLength(1);
    assertPipelineBounds(equivalent, harness);
    assertNoHostileIdentity(equivalent);

    const equivalentResolved = record(harness, equivalent.owner, 101, []);
    expect(equivalentResolved.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "resolved", count: 1 }),
    ]);
    expect(equivalentResolved.lines).toHaveLength(1);
    expect(equivalentResolved.lines[0]).toContain("reporter signal kind=resolved");
    assertPipelineBounds(equivalentResolved, harness);
    assertNoHostileIdentity(equivalentResolved);

    const unique = Array.from({ length: 2_000 }, (_, index) => hostileSignal(index));
    const forward = record(harness, {}, 100, unique);
    const reversed = record(harness, {}, 100, [...unique].reverse());

    expect(forward.owner).toEqual(reversed.owner);
    expect(forward.telemetry.reporterTransitions).toEqual(reversed.telemetry.reporterTransitions);
    expect(forward.status).toEqual(reversed.status);
    expect(forward.lines).toEqual(reversed.lines);
    expect(retainedEntries(forward.owner)).toHaveLength(harness.policy.maximumFingerprints);
    expect(forward.telemetry.reporterTransitions).toHaveLength(2);
    expect(forward.telemetry.reporterTransitions[0]).toMatchObject({
      category: "signal",
      kind: "first",
      reasonCode: "reporter-cardinality-overflow",
    });
    expect(forward.status.transitions).toHaveLength(2);
    assertPipelineBounds(forward, harness);
    assertNoHostileIdentity(forward);

    const reminder = record(harness, forward.owner, 110, unique);
    expect(reminder.telemetry.reporterTransitions[0]).toMatchObject({
      category: "signal",
      kind: "reminder",
      count: 2,
      reasonCode: "reporter-cardinality-overflow",
    });
    assertPipelineBounds(reminder, harness);
    assertNoHostileIdentity(reminder);
  });

  it("rejects work above the source signal ceiling before traversing it", () => {
    const harness = createHarness();
    const prior = record(harness, {}, 100, [hostileSignal(7)]);
    const oversized = new Array(harness.policy.maximumSignalsPerTick + 1) as ReporterSignal[];
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error("oversized reporter input must not be read");
      },
    });

    const result = record(harness, prior.owner, 101, oversized);

    expect(retainedEntries(result.owner)).toEqual(retainedEntries(prior.owner));
    expect(result.telemetry.reporterTransitions).toEqual([]);
    expect(result.status.transitions).toEqual([]);
    assertPipelineBounds(result, harness);
  });

  it("emits the exact default cadence for 2,000 equivalent signals across a heap reset", () => {
    const harness = createHarness();
    const signal = hostileSignal(17);
    const equivalentSignals = Array.from({ length: 2_000 }, () => signal);
    const stressTicks = new Set([100, 110, 130, 170, 250, 251, 410, 570]);
    let owner: unknown = {};
    const observed: {
      readonly tick: number;
      readonly kind: string;
      readonly count: number;
    }[] = [];
    let resolvedLines: readonly string[] = [];
    let quietLines: readonly string[] = [];

    for (let tick = 100; tick <= 572; tick += 1) {
      if (tick === 251) {
        owner = JSON.parse(JSON.stringify(owner));
        harness.service = new TelemetryService();
      }
      const step = record(
        harness,
        owner,
        tick,
        tick > 570 ? [] : stressTicks.has(tick) ? equivalentSignals : [signal],
      );
      owner = step.owner;
      const transition = step.status.transitions[0];
      if (transition?.category === "signal") {
        observed.push({ tick, kind: transition.kind, count: transition.count });
        expect(step.lines[0]).toContain(`reporter signal kind=${transition.kind}`);
      }
      if (tick === 571) resolvedLines = step.lines;
      if (tick === 572) quietLines = step.lines;
      assertPipelineBounds(step, harness);
      assertNoHostileIdentity(step);
    }

    expect(observed).toEqual([
      { tick: 100, kind: "first", count: 1 },
      { tick: 110, kind: "reminder", count: 2 },
      { tick: 130, kind: "reminder", count: 3 },
      { tick: 170, kind: "reminder", count: 4 },
      { tick: 250, kind: "reminder", count: 5 },
      { tick: 410, kind: "reminder", count: 6 },
      { tick: 570, kind: "reminder", count: 7 },
      { tick: 571, kind: "resolved", count: 7 },
    ]);
    expect(resolvedLines).toHaveLength(1);
    expect(resolvedLines[0]).toContain("[INFO]");
    expect(quietLines).toEqual([]);
    expect(retainedEntries(owner)).toEqual([]);
  });

  it("rebuilds malformed and future owners as a fresh bounded first observation", () => {
    const harness = createHarness();
    const signals = Array.from({ length: 2_000 }, (_, index) => hostileSignal(index));
    const fresh = record(harness, {}, 200, signals);
    const hostileOwners: readonly unknown[] = [
      { schemaVersion: 2, history: "RAW-PLAYER-HISTORY-W8N8" },
      {
        schemaVersion: 99,
        history: [{ tick: 1, hash: "RAW-PLAYER-FUTURE-W8N8" }],
        reporter: { entries: "RAW-PLAYER-FUTURE-REPORTER-W8N8" },
      },
      {
        schemaVersion: 2,
        history: [],
        droppedHistory: 0,
        reporter: {
          schemaVersion: 99,
          entries: {
            schemaVersion: 1,
            entries: [{ fingerprint: "fault:deadbeef", count: 9_999 }],
          },
          recovery: { signature: "RAW-PLAYER-RECOVERY-W8N8" },
        },
      },
    ];

    for (const hostileOwner of hostileOwners) {
      const rebuilt = record(harness, hostileOwner, 200, signals);
      expect(rebuilt.owner).toEqual(fresh.owner);
      expect(rebuilt.telemetry.reporterTransitions).toEqual(fresh.telemetry.reporterTransitions);
      expect(rebuilt.status).toEqual(fresh.status);
      expect(rebuilt.lines).toEqual(fresh.lines);
      expect(rebuilt.status.transitions.every(({ kind }) => kind === "first")).toBe(true);
      assertPipelineBounds(rebuilt, harness);
      assertNoHostileIdentity(rebuilt);
    }
  });
});

function createHarness() {
  const outcome = runTick({ game: game(99), memory: {} as Memory });
  const telemetry = outcome.telemetry;
  if (telemetry === null) throw new Error("expected telemetry fixture");
  const {
    activity: _activity,
    recoveryProgress: _recoveryProgress,
    reporterTransitions: _reporterTransitions,
    status: _status,
    ...base
  } = telemetry;
  void _activity;
  void _recoveryProgress;
  void _reporterTransitions;
  void _status;
  return {
    base,
    context: {
      colony: outcome.colony,
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
    },
    kernel: outcome.kernel,
    policy: buildRuntimeConfig().policy.reporter,
    service: new TelemetryService(),
  };
}

function record(
  harness: ReturnType<typeof createHarness>,
  owner: unknown,
  tick: number,
  reporterSignals: readonly ReporterSignal[],
) {
  const observed = harness.service.record(owner, {
    base: { ...harness.base, tick },
    ...harness.context,
    reporterSignals,
  });
  const status = projectReporterStatus(
    observed.telemetry,
    { ...harness.kernel, tick },
    harness.policy,
  );
  const lines = new ConsoleReporter().report(status, harness.policy, { log: () => undefined });
  return { ...observed, status, lines };
}

function hostileSignal(index: number): ReporterSignal {
  return {
    kind: "fault",
    identity: `RAW-PLAYER-W9N9/${String(index)}\u001b[2J<token>\ud83d\udea8`,
    reasonCode: "unexpected-exception",
  };
}

function retainedEntries(owner: unknown): readonly unknown[] {
  if (!isRecord(owner) || !isRecord(owner.reporter) || !isRecord(owner.reporter.entries)) {
    return [];
  }
  return Array.isArray(owner.reporter.entries.entries) ? owner.reporter.entries.entries : [];
}

function assertPipelineBounds(
  step: ReturnType<typeof record>,
  harness: ReturnType<typeof createHarness>,
): void {
  expect(step.telemetry.reporterTransitions.length).toBeLessThanOrEqual(
    harness.policy.maximumImmediateEventsPerTick,
  );
  expect(step.status.transitions.length).toBeLessThanOrEqual(
    harness.policy.maximumImmediateEventsPerTick,
  );
  expect(step.lines.length).toBeLessThanOrEqual(harness.policy.maximumLinesPerTick);
  expect(step.lines.reduce((bytes, line) => bytes + utf8ByteLength(line), 0)).toBeLessThanOrEqual(
    harness.policy.maximumBytesPerTick,
  );
  expect(utf8ByteLength(JSON.stringify(step.owner))).toBeLessThanOrEqual(
    step.telemetry.telemetryPolicy.maximumHistoryBytes,
  );
  expect(harness.policy.maximumImmediateEventsPerTick).toBe(2);
  expect(harness.policy.maximumSignalsPerTick).toBe(2_000);
  expect(
    harness.policy.maximumSignalsPerTick + step.telemetry.telemetryPolicy.maximumDetailRecords,
  ).toBe(2_064);
  expect(harness.policy.maximumFingerprints).toBe(64);
  expect(harness.policy.maximumLinesPerTick).toBe(3);
  expect(harness.policy.maximumBytesPerTick).toBe(1_536);
  expect(step.telemetry.telemetryPolicy.maximumHistoryBytes).toBe(8_192);
}

function assertNoHostileIdentity(step: ReturnType<typeof record>): void {
  const serialized = JSON.stringify(step);
  for (const raw of ["RAW-PLAYER", "W9N9", "<token>", "\u001b", "\ud83d\udea8"]) {
    expect(serialized).not.toContain(raw);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      index += 1;
      bytes += 4;
    } else bytes += 3;
  }
  return bytes;
}

function game(time: number) {
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: {},
    rooms: {},
    shard: { name: "shard3" },
    time,
  };
}
