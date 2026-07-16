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
      "phase2.colony",
      "phase2.layout",
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
    for (const secret of ["player-token", "raw-room", "<script>", "\u001b"]) {
      expect(serialized).not.toContain(secret);
    }

    const extraFields = new Proxy(
      {
        category: "signal",
        kind: "resolved",
        fingerprint: "extra-field-secret",
        count: 1,
        reasonCode: "unexpected-exception",
        rawPayload: "must-not-cross",
      },
      {
        ownKeys: () => {
          throw new Error("must not enumerate hostile transition fields");
        },
      },
    );
    const projectedExtraFields = project([extraFields]);
    expect(projectedExtraFields.transitions).toEqual([
      expect.objectContaining({ category: "signal", kind: "resolved", count: 1 }),
    ]);
    expect(JSON.stringify(projectedExtraFields)).not.toContain("must-not-cross");
  });

  it("rejects oversized transition arrays before traversal and never invokes accessors", () => {
    const outcome = runTick({ game: game(101), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    let visited = 0;
    const oversized = new Array<unknown>(2_000);
    Object.defineProperty(oversized, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        visited += 1;
        throw new Error("must not traverse oversized input");
      },
    });
    const policy = {
      ...buildRuntimeConfig().policy.reporter,
      maximumImmediateEventsPerTick: 2,
    };
    const status = projectReporterStatus(
      { ...telemetry, reporterTransitions: oversized } as unknown as TickTelemetry,
      outcome.kernel,
      policy,
    );

    expect(status).toMatchObject({ projectionStatus: "ready", transitions: [] });
    expect(visited).toBe(0);

    const accessor = {
      kind: "first",
      fingerprint: "raw-accessor-secret",
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
    const accessorStatus = projectReporterStatus(
      { ...telemetry, reporterTransitions: [accessor] } as unknown as TickTelemetry,
      outcome.kernel,
      policy,
    );
    expect(accessorStatus).toMatchObject({ projectionStatus: "ready", transitions: [] });
    expect(visited).toBe(0);
    expect(JSON.stringify(accessorStatus)).not.toContain("raw-accessor-secret");
  });

  it("orders equal-priority transitions canonically and saturates reminder arithmetic", () => {
    const outcome = runTick({ game: game(101), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const tied = [
      {
        category: "signal" as const,
        kind: "first" as const,
        fingerprint: "same-fingerprint",
        count: 2,
        reasonCode: "z-reason",
      },
      {
        category: "signal" as const,
        kind: "first" as const,
        fingerprint: "same-fingerprint",
        count: 1,
        reasonCode: "a-reason",
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

    expect(project(tied).transitions).toEqual(project([...tied].reverse()).transitions);
    expect(project(tied).transitions.map(({ reasonCode }) => reasonCode)).toEqual([
      "a-reason",
      "z-reason",
    ]);

    const mixedPriority = [
      {
        category: "signal" as const,
        kind: "first" as const,
        fingerprint: "ordinary-first",
        count: 1,
        reasonCode: "unexpected-exception",
      },
      {
        category: "signal" as const,
        kind: "reminder" as const,
        fingerprint: "overflow-reminder",
        count: 2,
        reasonCode: "reporter-cardinality-overflow",
      },
    ];
    expect(project(mixedPriority).transitions.map(({ reasonCode }) => reasonCode)).toEqual([
      "reporter-cardinality-overflow",
      "unexpected-exception",
    ]);

    const overflow = projectReporterStatus(
      {
        ...telemetry,
        reporterTransitions: [
          {
            category: "recovery",
            kind: "stuck",
            owner: "colony",
            blockerReasonCode: "no-spawn",
            blockerRef: null,
            lastProgressTick: 101,
            reminderAtTick: Number.MAX_SAFE_INTEGER,
            reasonCode: "recovery-progress-unchanged",
          },
        ],
      } as unknown as TickTelemetry,
      { ...outcome.kernel, tick: Number.MAX_SAFE_INTEGER },
      policy,
    );
    expect(overflow.transitions[0]).toMatchObject({
      category: "recovery",
      reminderAtTick: Number.MAX_SAFE_INTEGER,
    });
  });

  it("drops an expired or overlong diagnostic receipt at projection time", () => {
    const outcome = runTick({ game: game(101), memory: {} as Memory });
    const telemetry = outcome.telemetry;
    if (telemetry === null) throw new Error("expected telemetry");
    const policy = buildRuntimeConfig().policy.reporter;
    const projectDiagnostic = (expiresAtTick: number) =>
      projectReporterStatus(
        {
          ...telemetry,
          observerDiagnostic: { level: "debug", categories: ["faults"], expiresAtTick },
        },
        outcome.kernel,
        policy,
      ).diagnostic;

    expect(projectDiagnostic(101)).toBeNull();
    expect(projectDiagnostic(102)).toEqual({
      level: "debug",
      categories: ["faults"],
      expiresAtTick: 102,
    });
    expect(projectDiagnostic(101 + policy.maximumDiagnosticDurationTicks + 1)).toBeNull();
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
