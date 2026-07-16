import { describe, expect, it } from "vitest";
import { advanceRecoveryProgress, advanceReporterState } from "../src/telemetry/reporter-state";

const policy = {
  maximumFingerprints: 2,
  initialReminderDelayTicks: 2,
  maximumReminderDelayTicks: 8,
};

describe("reporter state", () => {
  it("emits deterministic first, exponential reminder, and resolution evidence", () => {
    const signal = [
      { kind: "blocker", identity: "hostile-token-W1N1", reasonCode: "insufficient-energy" },
    ];
    const first = advanceReporterState(undefined, 10, signal, policy);
    const quiet = advanceReporterState(first.owner, 11, signal, policy);
    const reminder = advanceReporterState(quiet.owner, 12, signal, policy);
    const resolved = advanceReporterState(reminder.owner, 13, [], policy);
    expect(first.events.map(({ kind }) => kind)).toEqual(["first"]);
    expect(quiet.events).toEqual([]);
    expect(reminder.events.map(({ kind }) => kind)).toEqual(["reminder"]);
    expect(resolved.events.map(({ kind }) => kind)).toEqual(["resolved"]);
    expect(JSON.stringify(first)).not.toContain("hostile-token-W1N1");
  });

  it("caps retained fingerprints deterministically and rebuilds malformed owner data", () => {
    const result = advanceReporterState(
      { entries: [{ fingerprint: 3 }] },
      1,
      [
        { kind: "fault", identity: "b", reasonCode: "unexpected-exception" },
        { kind: "fault", identity: "a", reasonCode: "unexpected-exception" },
        { kind: "fault", identity: "c", reasonCode: "unexpected-exception" },
      ],
      policy,
    );
    expect((result.owner as { entries: unknown[] }).entries).toHaveLength(2);

    const future = advanceReporterState(
      {
        schemaVersion: 99,
        entries: [
          {
            fingerprint: "fault:deadbeef",
            count: 4,
            lastTick: 1,
            nextReminderTick: 2,
            reasonCode: "unexpected-exception",
          },
        ],
      },
      2,
      [{ kind: "fault", identity: "a", reasonCode: "unexpected-exception" }],
      policy,
    );
    expect(future.events).toEqual([expect.objectContaining({ kind: "first", count: 1 })]);
  });

  it("deduplicates thousands of reordered hostile signals without retaining hostile text", () => {
    const hostile = Array.from({ length: 2_000 }, (_, index) => ({
      kind: "fault",
      identity: `alliance-secret-W9N9-${String(index % 17)}`,
      reasonCode: index % 2 === 0 ? "unexpected-exception" : "unexpected-exception",
    }));
    const first = advanceReporterState(undefined, 10, hostile, policy);
    const reversed = advanceReporterState(undefined, 10, [...hostile].reverse(), policy);
    expect(first).toEqual(reversed);
    expect((first.owner as { entries: readonly unknown[] }).entries).toHaveLength(2);
    expect(first.events).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain("alliance-secret-W9N9");
  });
});

describe("recovery progress", () => {
  const recoveryPolicy = {
    stuckWindowTicks: 3,
    initialReminderDelayTicks: 2,
    maximumReminderDelayTicks: 8,
  };
  const input = (tick: number, overrides = {}) => ({
    tick,
    active: true,
    status: "recovering",
    spawnDemand: 1,
    spawnScheduled: 0,
    harvested: 0,
    delivered: 0,
    unmet: 1,
    blockerRef: "W1N1/spawn-a",
    blockerReasonCode: "insufficient-energy",
    ...overrides,
  });

  it("reports unchanged recovery once at the threshold and resets on progress or completion", () => {
    const first = advanceRecoveryProgress(undefined, input(10), recoveryPolicy);
    const waiting = advanceRecoveryProgress(first.owner, input(12), recoveryPolicy);
    const stuck = advanceRecoveryProgress(waiting.owner, input(13), recoveryPolicy);
    expect(stuck.event).toMatchObject({
      owner: "colony",
      reasonCode: "recovery-progress-unchanged",
      lastProgressTick: 10,
    });
    expect(JSON.stringify(stuck)).not.toContain("W1N1/spawn-a");
    const progressing = advanceRecoveryProgress(
      stuck.owner,
      input(14, { harvested: 1 }),
      recoveryPolicy,
    );
    expect(progressing.status).toMatchObject({ stuck: false, lastProgressTick: 14 });
    const complete = advanceRecoveryProgress(
      progressing.owner,
      input(15, { active: false }),
      recoveryPolicy,
    );
    expect(complete).toEqual({ owner: null, event: null, status: null });
  });
});
