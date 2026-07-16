import { describe, expect, it } from "vitest";
import { runTick } from "../src/runtime/tick";
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
    expect(next.owner).toMatchObject({ schemaVersion: 1, history: [{ tick: 101 }] });
    expect(next.owner.droppedHistory).toBe(1);
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
