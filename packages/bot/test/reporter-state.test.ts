import { describe, expect, it } from "vitest";
import { advanceRecoveryProgress, advanceReporterState } from "../src/telemetry/reporter-state";

const policy = {
  maximumInputSignals: 2_000,
  maximumFingerprints: 2,
  maximumRetainedFingerprints: 2,
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

  it("rejects oversized persisted arrays before reading their entries", () => {
    const entries = new Array(3) as unknown[];
    Object.defineProperty(entries, 0, {
      get: () => {
        throw new Error("oversized entry must not be read");
      },
    });
    const result = advanceReporterState(
      { schemaVersion: 1, entries },
      10,
      [{ kind: "fault", identity: "system-a", reasonCode: "unexpected-exception" }],
      policy,
    );
    expect(result.events).toEqual([expect.objectContaining({ kind: "first", count: 1 })]);
  });

  it("uses one stable overflow fingerprint when saturated evidence changes", () => {
    const saturatedPolicy = {
      ...policy,
      maximumFingerprints: 64,
      maximumRetainedFingerprints: 64,
    };
    const incumbents = Array.from({ length: 64 }, (_, index) => ({
      kind: "fault",
      identity: `old-${String(index)}`,
      reasonCode: "unexpected-exception",
    }));
    const initial = advanceReporterState(undefined, 10, incumbents, saturatedPolicy);
    const changedSignals = [
      ...incumbents,
      { kind: "fault", identity: "current-21", reasonCode: "unexpected-exception" },
    ];
    const changed = advanceReporterState(initial.owner, 11, changedSignals, saturatedPolicy);
    const stable = advanceReporterState(changed.owner, 12, changedSignals, saturatedPolicy);
    const entries = (changed.owner as { entries: readonly { fingerprint: string }[] }).entries;

    expect(entries).toHaveLength(64);
    expect(
      entries.some(({ fingerprint }) => /^reporter-overflow:[0-9a-f]{8}$/.test(fingerprint)),
    ).toBe(true);
    expect(changed.events).toEqual([
      expect.objectContaining({ kind: "first", reasonCode: "reporter-cardinality-overflow" }),
    ]);
    expect(stable.events.filter(({ kind }) => kind === "first")).toEqual([]);
    expect(
      stable.events.filter(({ reasonCode }) => reasonCode === "reporter-cardinality-overflow"),
    ).toEqual([]);
    expect(JSON.stringify(changed)).not.toContain("current-21");
  });

  it("hashes the complete omitted set when a late overflow member changes", () => {
    const saturatedPolicy = {
      ...policy,
      maximumFingerprints: 64,
      maximumRetainedFingerprints: 64,
    };
    const signals = Array.from({ length: 2_000 }, (_, index) => ({
      kind: "fault",
      identity: `old-${String(index)}`,
      reasonCode: "unexpected-exception",
    }));
    const initial = advanceReporterState(undefined, 100, signals, saturatedPolicy);
    const changedSignals = signals.map((signal) =>
      signal.identity === "old-1242" ? { ...signal, identity: "fresh-0" } : signal,
    );
    const changed = advanceReporterState(initial.owner, 101, changedSignals, saturatedPolicy);
    const initialOverflow = (
      initial.owner as { entries: readonly { fingerprint: string }[] }
    ).entries
      .map(({ fingerprint }) => fingerprint)
      .find((fingerprint) => fingerprint.startsWith("reporter-overflow:"));
    const changedOverflow = (
      changed.owner as { entries: readonly { fingerprint: string }[] }
    ).entries
      .map(({ fingerprint }) => fingerprint)
      .find((fingerprint) => fingerprint.startsWith("reporter-overflow:"));

    expect(initialOverflow).toMatch(/^reporter-overflow:[0-9a-f]{8}$/);
    expect(changedOverflow).toMatch(/^reporter-overflow:[0-9a-f]{8}$/);
    expect(changedOverflow).not.toBe(initialOverflow);
    expect(changed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "first", reasonCode: "reporter-cardinality-overflow" }),
        expect.objectContaining({ kind: "resolved", reasonCode: "reporter-cardinality-overflow" }),
      ]),
    );
    expect(JSON.stringify(changed)).not.toContain("fresh-0");
  });

  it("rebuilds future reminder timestamps instead of suppressing evidence", () => {
    const signal = [{ kind: "fault", identity: "system-a", reasonCode: "unexpected-exception" }];
    const seed = advanceReporterState(undefined, 10, signal, policy);
    const [entry] = (seed.owner as { entries: Record<string, unknown>[] }).entries;
    const rebuilt = advanceReporterState(
      {
        schemaVersion: 1,
        entries: [
          {
            ...entry,
            lastTick: 11,
            nextReminderTick: Number.MAX_SAFE_INTEGER,
          },
        ],
      },
      10,
      signal,
      policy,
    );

    expect(rebuilt.events).toEqual([expect.objectContaining({ kind: "first", count: 1 })]);
  });

  it("saturates reminder ticks and counters at the largest safe integer", () => {
    const signal = [{ kind: "fault", identity: "system-a", reasonCode: "unexpected-exception" }];
    const seed = advanceReporterState(undefined, 1, signal, policy);
    const [entry] = (seed.owner as { entries: Record<string, unknown>[] }).entries;
    const result = advanceReporterState(
      {
        schemaVersion: 1,
        entries: [
          {
            ...entry,
            count: Number.MAX_SAFE_INTEGER,
            lastTick: Number.MAX_SAFE_INTEGER - 1,
            nextReminderTick: Number.MAX_SAFE_INTEGER,
          },
        ],
      },
      Number.MAX_SAFE_INTEGER,
      signal,
      {
        maximumInputSignals: 2_000,
        maximumFingerprints: 2,
        maximumRetainedFingerprints: 2,
        initialReminderDelayTicks: Number.MAX_SAFE_INTEGER,
        maximumReminderDelayTicks: Number.MAX_SAFE_INTEGER,
      },
    );
    expect(result.events).toEqual([
      expect.objectContaining({ kind: "reminder", count: Number.MAX_SAFE_INTEGER }),
    ]);
    expect((result.owner as { entries: Record<string, unknown>[] }).entries[0]).toMatchObject({
      count: Number.MAX_SAFE_INTEGER,
      lastTick: Number.MAX_SAFE_INTEGER,
      nextReminderTick: Number.MAX_SAFE_INTEGER,
    });
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

  it("saturates recovery reminder state at the largest safe integer", () => {
    const seed = advanceRecoveryProgress(
      undefined,
      input(Number.MAX_SAFE_INTEGER - 3),
      recoveryPolicy,
    );
    const result = advanceRecoveryProgress(
      {
        ...(seed.owner as Record<string, unknown>),
        lastProgressTick: Number.MAX_SAFE_INTEGER - 3,
        reminderAtTick: Number.MAX_SAFE_INTEGER,
        reminderCount: Number.MAX_SAFE_INTEGER,
        stuckReportedAtTick: Number.MAX_SAFE_INTEGER - 3,
      },
      input(Number.MAX_SAFE_INTEGER),
      recoveryPolicy,
    );
    expect(result.event).toMatchObject({
      lastProgressTick: Number.MAX_SAFE_INTEGER - 3,
      reminderAtTick: Number.MAX_SAFE_INTEGER,
      stuck: true,
    });
    expect(result.owner).toMatchObject({
      reminderAtTick: Number.MAX_SAFE_INTEGER,
      reminderCount: Number.MAX_SAFE_INTEGER,
      stuckReportedAtTick: Number.MAX_SAFE_INTEGER,
    });
  });

  it("rebuilds future recovery timestamps at the current observation", () => {
    const seed = advanceRecoveryProgress(undefined, input(10), recoveryPolicy);
    const rebuilt = advanceRecoveryProgress(
      {
        ...(seed.owner as Record<string, unknown>),
        lastProgressTick: 12,
        reminderAtTick: Number.MAX_SAFE_INTEGER,
        stuckReportedAtTick: 12,
      },
      input(11),
      recoveryPolicy,
    );

    expect(rebuilt.event).toBeNull();
    expect(rebuilt.status).toMatchObject({ lastProgressTick: 11, stuck: false });
  });
});
