import { describe, expect, it } from "vitest";
import checkedEvidence from "../../../docs/phase2-logistics-results.json";
import { collectLogisticsEvidence } from "./fixtures/phase2-logistics";

describe("Phase 2 logistics composed deterministic evidence (#47)", () => {
  it("matches checked evidence and proves the logistics acceptance matrix", () => {
    const actual = collectLogisticsEvidence();

    expect(actual).toEqual(checkedEvidence);
    expect(actual.deterministicScenario.equivalentAfterWarmResetAndReorder).toBe(true);
    expect(actual.deterministicScenario.noDoubleReservation).toBe(true);
    expect(actual.deterministicScenario.admittedFlowOrder).toEqual([
      "flow/container-extension",
      "flow/container-spawn",
      "flow/container-storage",
      "flow/drop-storage",
      "flow/ruin-factory",
      "flow/storage-terminal",
      "flow/tombstone-lab",
    ]);
    expect(actual.deterministicScenario.observedEndpoints).toEqual([
      "container",
      "drop",
      "extension",
      "factory",
      "lab",
      "ruin",
      "spawn",
      "storage",
      "terminal",
      "tombstone",
    ]);
    expect(actual.deterministicScenario.mandatoryUnderPressure).toMatchObject({
      admittedAmount: 250,
      admittedFlows: ["flow/container-extension", "flow/container-spawn"],
      optionalFlowsScheduled: 0,
      protectedRecoveryEnergy: 300,
    });
    expect(actual.deterministicScenario.haulerDemand).toMatchObject({
      converged: true,
      carry: 4,
      move: 4,
    });
    expect(actual.recovery.partialDelivery).toMatchObject({
      cargo: 20,
      delivered: 30,
      remaining: 170,
      stage: "deliver",
    });
    expect(actual.recovery.actorDeath).toMatchObject({
      cycle: 1,
      delivered: 30,
      reacquireAmount: 170,
      reason: "actor-dead",
    });
    expect(actual.recovery.resetRecovery).toMatchObject({
      cycle: 1,
      delivered: 30,
      flowId: "flow/container-spawn",
      reserved: 200,
    });
    expect(actual.recovery.vanishedEndpoint).toEqual({
      admittedAfterVanishing: 0,
      ghostSinkReservations: 0,
      reason: "sink-vanished",
      requestActive: false,
      retirements: 1,
    });
    expect(actual.recovery.droppedDecay.reserved).toBeLessThanOrEqual(
      actual.recovery.droppedDecay.observed,
    );
    expect(actual.recovery.fullAndEmptyStores).toEqual({
      emptySourceReason: "empty-source",
      emptySourceReservations: 0,
      fullSinkReason: "full-sink",
      fullSinkReservations: 0,
    });
    expect(actual.telemetry).toMatchObject({
      cpuUsed: 0.25,
      deliveredDelta: 30,
      droppedAtCap: 1,
      latencyTicks: 1,
      lossDelta: 20,
      pickedUpDelta: 50,
      planUnchanged: true,
      resetDeltas: { delivered: 0, loss: 0, pickedUp: 0 },
      schemaVersion: 1,
      requested: 520,
      scheduled: 520,
      shortfall: 0,
    });
    expect(actual.telemetry.persistedBytes).toBeLessThanOrEqual(4_096);
    expect(actual.boundaries).toEqual({
      commandsIssued: 0,
      nonGoals: ["#48 link commands", "#49 container repair", "terminal sends", "market"],
      observerOnly: true,
    });
  });
});
