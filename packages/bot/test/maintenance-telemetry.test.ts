import { describe, expect, it } from "vitest";
import {
  projectMaintenanceTelemetry,
  type ConstructionPlanningResult,
  type MaintenanceTelemetryInput,
} from "../src/maintenance";
import type { CommandExecutionResult, IntentEnvelope } from "../src/execution";
import type { DefenseIntentKind } from "../src/defense/director";

describe("maintenance telemetry", () => {
  it("projects bounded settled planner, funding, tower, reserve, and retirement outcomes", () => {
    const input = fixture();
    const result = projectMaintenanceTelemetry(input);

    expect(result).toEqual({
      planner: { scanned: 9, admitted: 2, deferred: 3, truncated: 1 },
      energy: { requestedCap: 30, fundedCap: 20 },
      towers: {
        scheduled: 1,
        rejected: 1,
        failed: 1,
        cpuUsed: 0.75,
        energyScheduled: 10,
        reasons: [
          { reason: "adapter-fault", count: 1 },
          { reason: "duplicate-target", count: 1 },
          { reason: "ok", count: 1 },
        ],
        droppedReasonBuckets: 0,
        truncatedObservations: 0,
      },
      emergencyReservePreserved: true,
      duplicateTargetsSuppressed: 2,
      work: { overshoot: 1, retired: 2, satisfied: 1 },
    });
    expect(Object.isFrozen(result.towers.reasons)).toBe(true);
  });

  it("is reset-safe and order deterministic while enforcing the observation cap", () => {
    const input = fixture();
    const overflow = Array.from({ length: 130 }, (_, index) =>
      command(`repair-${String(index).padStart(3, "0")}`, "executed", "OK", 0.5),
    );
    const forward = projectMaintenanceTelemetry({ ...input, towerCommands: overflow });
    const rebuilt = projectMaintenanceTelemetry({
      ...input,
      towerCommands: [...overflow].reverse(),
    });

    expect(rebuilt).toEqual(forward);
    expect(forward.towers.scheduled).toBe(128);
    expect(forward.towers.truncatedObservations).toBe(3);
    expect(projectMaintenanceTelemetry(undefined)).toEqual(projectMaintenanceTelemetry(undefined));
  });
});

function fixture(): MaintenanceTelemetryInput {
  return {
    planning: {
      scannedStructures: 9,
      proposals: [{}, {}] as unknown as ConstructionPlanningResult["proposals"],
      deferred: [],
      deferredCount: 3,
      truncatedStructures: 1,
    },
    requestedEnergyCaps: [20, 10],
    fundedEnergyCaps: [20],
    towerCommands: [
      command("b", "failed", "adapter-fault", 0.5),
      command("a", "executed", "OK", 0.25),
    ],
    towerRejections: [{ targetId: "road-c", reason: "duplicate target" }],
    emergencyReservePreserved: true,
    duplicateTargetsSuppressed: 2,
    workOutcomes: ["retired", "overshoot", "satisfied", "retired"],
  };
}

function command(
  intentId: string,
  status: CommandExecutionResult<IntentEnvelope<DefenseIntentKind>>["status"],
  reason: CommandExecutionResult<IntentEnvelope<DefenseIntentKind>>["reason"],
  cpuUsed: number,
): CommandExecutionResult<IntentEnvelope<DefenseIntentKind>> {
  const executed = status === "executed";
  return {
    intentId,
    tick: 100,
    command: {
      id: intentId,
      kind: "tower.repair",
      issuer: "maintenance/W1N1",
      tick: 100,
      target: intentId,
      snapshotRevision: "world:100",
      exclusiveResourceKey: `tower/${intentId}`,
      priority: { class: "maintenance", value: 1 },
      deadline: 100,
      budget: { id: "maintenance-v2/W1N1", cost: 10 },
      preconditions: [],
      payload: { towerId: intentId },
    },
    status,
    reason,
    returnCode: executed ? 0 : null,
    cpuUsed,
    outcome: executed
      ? { state: "scheduled", code: 0, name: "OK" }
      : { state: "adapter-fault", code: null, name: null, error: "redacted" },
  };
}
