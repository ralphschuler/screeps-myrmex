import { describe, expect, it } from "vitest";
import { advanceReporterState } from "../src/telemetry/reporter-state";

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
  });
});
