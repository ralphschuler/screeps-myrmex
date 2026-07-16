import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { runTick } from "../src/runtime/tick";
import type { TickTelemetry } from "../src/telemetry/metrics";
import { projectReporterStatus } from "../src/telemetry/reporter-status";

describe("ReporterStatus", () => {
  it("publishes a bounded redacted tick-local projection", () => {
    const outcome = runTick({ game: game(100), memory: {} as Memory });
    const status = outcome.reporterStatus;

    expect(status).toMatchObject({ schemaVersion: 2, tick: 100, projectionStatus: "ready" });
    expect(status.runtime.shardRef).toMatch(/^shard:[0-9a-f]{8}$/);
    expect(JSON.stringify(status)).not.toContain("shard3");
    expect(status.gates.map(({ id }) => id)).toEqual([
      "phase1.colony",
      "phase1.contracts",
      "phase1.spawn",
      "phase1.movement",
      "phase1.agents",
      "phase1.economy",
      "phase1.recovery",
      "phase1.growth",
      "phase1.safety",
      "phase1.telemetry",
      "phase1.critical-maintenance",
    ]);
  });

  it("caps and sanitizes blockers without changing telemetry", () => {
    const outcome = runTick({ game: game(101), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const hostile = {
      ...telemetry,
      status: {
        ...telemetry.status,
        details: [
          {
            domain: "spawn" as const,
            entityId: "token-secret-W1N1",
            status: "<script>",
            reason: "bad\u001b[2J",
          },
          {
            domain: "budget" as const,
            entityId: "other",
            status: "denied",
            reason: "insufficient-energy",
          },
        ],
      },
    };
    const status = projectReporterStatus(hostile, outcome.kernel, {
      ...buildRuntimeConfig().policy.reporter,
      maximumImmediateEventsPerTick: 1,
    });

    expect(status.blockers).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("token-secret-W1N1");
    expect(JSON.stringify(status)).not.toContain("<script>");
    expect(JSON.stringify(status)).not.toContain("\u001b");
  });

  it("projects deterministic exact transition shapes and redacts hostile values", () => {
    const outcome = runTick({ game: game(101), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const hostileTransitions = [
      {
        category: "signal",
        kind: "first",
        fingerprint: "player-token-W9N9\u001b[2J",
        count: 2_000_000,
        reasonCode: "<script>alert-room</script>",
      },
      {
        category: "recovery",
        kind: "stuck",
        owner: "colony",
        blockerReasonCode: "player-W8N8\u001b[2J",
        blockerRef: "raw-room-W8N8/source-22-11",
        lastProgressTick: 90,
        reminderAtTick: 10_000,
        reasonCode: "recovery-progress-unchanged",
      },
      {
        category: "signal",
        kind: "resolved",
        fingerprint: "extra-field-secret",
        count: 1,
        reasonCode: "unexpected-exception",
        rawPayload: "must-not-cross",
      },
      { category: "unknown", rawPayload: "unknown-room-W7N7" },
      {
        category: "signal",
        kind: "reminder",
        fingerprint: "negative-counter-secret",
        count: -1,
        reasonCode: "unexpected-exception",
      },
    ];
    const policy = {
      ...buildRuntimeConfig().policy.reporter,
      maximumImmediateEventsPerTick: 2,
    };
    const project = (transitions: readonly unknown[]) =>
      projectReporterStatus(
        { ...telemetry, reporterTransitions: transitions } as unknown as TickTelemetry,
        outcome.kernel,
        policy,
      );

    const status = project(hostileTransitions);
    const reversed = project([...hostileTransitions].reverse());

    expect(status.transitions).toEqual(reversed.transitions);
    expect(status.transitions).toHaveLength(2);
    expect(status.transitions[0]).toMatchObject({
      category: "recovery",
      kind: "stuck",
      owner: "colony",
      blockerReasonCode: "invalid-code",
      lastProgressTick: 90,
      reminderAtTick: 261,
    });
    expect(status.transitions[1]).toMatchObject({
      category: "signal",
      kind: "first",
      count: 1_000_000,
      reasonCode: "invalid-code",
    });
    expect(
      status.transitions[0]?.category === "recovery" && status.transitions[0].blockerRef,
    ).toMatch(/^reporter-blocker:[0-9a-f]{8}$/);
    expect(
      status.transitions[1]?.category === "signal" && status.transitions[1].fingerprint,
    ).toMatch(/^reporter-transition:[0-9a-f]{8}$/);
    const serialized = JSON.stringify(status);
    for (const secret of [
      "player-token",
      "raw-room",
      "must-not-cross",
      "unknown-room",
      "negative-counter",
      "<script>",
      "\u001b",
    ]) {
      expect(serialized).not.toContain(secret);
    }
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
