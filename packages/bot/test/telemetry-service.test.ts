import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { runTick } from "../src/runtime/tick";
import { ConsoleReporter } from "../src/telemetry/console-reporter";
import { projectReporterStatus } from "../src/telemetry/reporter-status";
import { TelemetryService } from "../src/telemetry/service";

describe("TelemetryService", () => {
  it("canonicalizes capped details and retains only a bounded observer history", () => {
    const outcome = runTick({ game: game(100), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const base = telemetry;
    const service = new TelemetryService();
    const decisions = [
      {
        reservationId: "z-budget",
        colonyId: "W1N1",
        category: "optional-growth",
        issuer: "growth/z",
        revision: 1,
        status: "denied",
        reasonCode: "insufficient-energy",
        grant: null,
      },
      {
        reservationId: "a-budget",
        colonyId: "W1N1",
        category: "optional-growth",
        issuer: "growth/a",
        revision: 1,
        status: "denied",
        reasonCode: "insufficient-cpu",
        grant: null,
      },
    ] as const;
    const input = {
      base: {
        ...base,
        telemetryPolicy: {
          ...base.telemetryPolicy,
          maximumDetailRecords: 1,
          maximumHistoryEntries: 1,
        },
      },
      colony: { ...outcome.colony, decisions },
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
      reporterSignals: [],
    } as const;

    const first = service.record({}, input);
    const reversed = service.record(
      {},
      { ...input, colony: { ...input.colony, decisions: [...decisions].reverse() } },
    );
    expect(first.telemetry.status).toEqual(reversed.telemetry.status);
    expect(first.telemetry.status.details).toHaveLength(1);
    const [detail] = first.telemetry.status.details;
    expect(detail).toMatchObject({ domain: "budget", status: "denied" });
    expect(detail?.entityId).toMatch(/^budget:[0-9a-f]{8}$/);
    expect(detail?.entityId).not.toContain("a-budget");
    expect(first.telemetry.status.droppedDetails).toBe(1);

    const next = service.record(first.owner, {
      ...input,
      base: { ...input.base, tick: 101 },
    });
    expect(next.owner).toMatchObject({ schemaVersion: 2, history: [{ tick: 101 }] });
    expect(next.owner.droppedHistory).toBe(1);
  });

  it("publishes bounded recovery transitions while Memory is ready without persisting a queue", () => {
    const outcome = runTick({ game: game(100), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
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
    const service = new TelemetryService();
    const denied = {
      reservationId: "secret-W1N1-recovery-budget",
      colonyId: "W1N1",
      category: "emergency-spawn",
      issuer: "colony/W1N1/restore-workforce",
      revision: 1,
      status: "denied",
      reasonCode: "insufficient-energy",
      grant: null,
    } as const;
    const inputAt = (tick: number) => ({
      base: {
        ...base,
        tick,
        memoryStatus: "ready" as const,
        colony: {
          ...base.colony,
          states: base.colony.states.map((state) => ({
            ...state,
            count: state.id === "bootstrapping" ? 1 : 0,
          })),
        },
        reporterPolicy: {
          ...base.reporterPolicy,
          initialReminderDelayTicks: 2,
          maximumImmediateEventsPerTick: 2,
          maximumReminderDelayTicks: 8,
          stuckRecoveryWindowTicks: 3,
        },
      },
      colony: { ...outcome.colony, decisions: [denied] },
      contracts: outcome.contracts,
      execution: outcome.execution,
      growth: [],
      maintenance: [],
      movement: outcome.movement,
      snapshot: outcome.snapshot,
      spawn: outcome.spawn,
      reporterSignals: [],
    });

    const first = service.record({}, inputAt(10));
    const reminder = service.record(first.owner, inputAt(12));
    const stuck = service.record(reminder.owner, inputAt(13));

    expect(first.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(reminder.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "reminder", count: 2 }),
    ]);
    expect(stuck.telemetry.recoveryProgress).toMatchObject({
      stuck: true,
      lastProgressTick: 10,
      reminderAtTick: 15,
    });
    expect(stuck.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({
        category: "recovery",
        kind: "stuck",
        owner: "colony",
        blockerReasonCode: "insufficient-energy",
        lastProgressTick: 10,
        reminderAtTick: 15,
        reasonCode: "recovery-progress-unchanged",
      }),
    ]);
    const recoveryTransition = stuck.telemetry.reporterTransitions.find(
      (transition) => transition.category === "recovery",
    );
    expect(recoveryTransition?.blockerRef).toMatch(/^recovery-blocker:[0-9a-f]{8}$/);
    expect(stuck.owner).not.toHaveProperty("reporter.events");
    expect(JSON.stringify(stuck.owner)).not.toContain("secret-W1N1-recovery-budget");
    const reporterPolicy = {
      ...buildRuntimeConfig().policy.reporter,
      heartbeatIntervalTicks: 10,
      maximumReminderDelayTicks: 8,
    };
    const status = projectReporterStatus(
      stuck.telemetry,
      { ...outcome.kernel, tick: 13 },
      reporterPolicy,
    );
    const lines = new ConsoleReporter().report(status, reporterPolicy, { log: () => undefined });
    expect(status.transitions).toEqual([
      expect.objectContaining({
        category: "recovery",
        kind: "stuck",
        owner: "colony",
        lastProgressTick: 10,
        reminderAtTick: 15,
      }),
    ]);
    expect(lines[0]).toContain("reporter recovery kind=stuck owner=colony");
    expect(lines[0]).toContain("reason=recovery-progress-unchanged");
    expect(lines.join("\n")).not.toContain("W1N1");

    const future = service.record(
      {
        ...stuck.owner,
        reporter: {
          schemaVersion: 2,
          entries: {
            schemaVersion: 99,
            entries: [
              {
                fingerprint: "fault:deadbeef",
                count: 50,
                lastTick: 1,
                nextReminderTick: 2,
                reasonCode: "unexpected-exception",
              },
            ],
          },
          recovery: { signature: "future-player-value" },
        },
      },
      inputAt(14),
    );
    expect(future.telemetry.reporterTransitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "first", count: 1 }),
    ]);
    expect(future.telemetry.recoveryProgress).toMatchObject({
      stuck: false,
      lastProgressTick: 14,
    });
    expect(JSON.stringify(future)).not.toContain("future-player-value");
  });
});

function game(time: number) {
  return {
    cpu: { bucket: 9_000, limit: 20, tickLimit: 500, getUsed: () => 0 },
    creeps: {},
    rooms: {},
    shard: { name: "shard3" },
    time,
  };
}
