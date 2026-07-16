import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { runTick } from "../src/runtime/tick";
import { projectReporterStatus } from "../src/telemetry/reporter-status";

describe("ReporterStatus", () => {
  it("publishes a bounded redacted tick-local projection", () => {
    const outcome = runTick({ game: game(100), memory: {} as Memory });
    const status = outcome.reporterStatus;

    expect(status).toMatchObject({ schemaVersion: 1, tick: 100, projectionStatus: "ready" });
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
