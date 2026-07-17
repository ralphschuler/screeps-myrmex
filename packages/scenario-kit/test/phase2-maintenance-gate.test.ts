import { describe, expect, it } from "vitest";
import checkedEvidence from "../../../docs/phase2-maintenance-results.json";
import { collectPhase2MaintenanceEvidence } from "./fixtures/phase2-maintenance";

describe("Phase 2 bounded composed maintenance evidence (#243)", () => {
  it("matches checked evidence and proves every maintenance acceptance bound", () => {
    const actual = collectPhase2MaintenanceEvidence();

    expect(actual).toEqual(checkedEvidence);
    expect(actual.sustainedDecay.road.minimumObservedHits).toBeGreaterThanOrEqual(
      actual.sustainedDecay.road.floor,
    );
    expect(actual.sustainedDecay.container.minimumObservedHits).toBeGreaterThanOrEqual(
      actual.sustainedDecay.container.floor,
    );
    expect(actual.sustainedDecay).toMatchObject({
      ticks: 12,
      maximumCpuPerTick: 0.125,
      maximumRequestsPerTick: 2,
      maximumRequestedEnergyPerTick: 400,
      commandFailureCount: 1,
    });
    expect(actual.sustainedDecay.maximumFundedEnergyPerTick).toBeLessThanOrEqual(400);

    expect(actual.protectedPriorities.grants.slice(0, 5)).toEqual([
      expect.objectContaining({ category: "emergency-spawn", energy: 300, status: "granted" }),
      expect.objectContaining({ category: "defense", energy: 100, status: "granted" }),
      expect.objectContaining({ category: "replacement", energy: 150, status: "granted" }),
      expect.objectContaining({ category: "harvesting-filling", energy: 50, status: "granted" }),
      expect.objectContaining({ category: "controller-risk", energy: 50, status: "granted" }),
    ]);
    expect(actual.protectedPriorities.maintenanceEnergy).toBe(222);
    expect(actual.protectedPriorities.maintenanceEnergy).toBeLessThanOrEqual(350);
    expect(actual.protectedPriorities.cpuCap).toBe(1);

    expect(actual.fortificationBands).toEqual([
      expect.objectContaining({
        name: "rcl3-protected",
        targets: [],
        deferredProtected: 2,
        targetsHitsMax: false,
      }),
      expect.objectContaining({
        name: "rcl3-surplus",
        targets: [
          { structureClass: "rampart", targetHits: 20_000 },
          { structureClass: "wall", targetHits: 20_000 },
        ],
        targetsHitsMax: false,
      }),
      expect.objectContaining({
        name: "rcl3-threat",
        targets: [
          { structureClass: "rampart", targetHits: 40_000 },
          { structureClass: "wall", targetHits: 40_000 },
        ],
        towerEligible: false,
      }),
      expect.objectContaining({
        name: "rcl6-surplus",
        targets: [
          { structureClass: "rampart", targetHits: 200_000 },
          { structureClass: "wall", targetHits: 200_000 },
        ],
        targetsHitsMax: false,
      }),
    ]);

    expect(actual.towerArbitration).toMatchObject({
      clear: [{ kind: "tower.repair", target: "road-critical" }],
      heal: [{ kind: "tower.heal", target: "worker" }],
      attack: [{ kind: "tower.attack", target: "hostile" }],
      routineDuringHeal: 0,
      routineDuringAttack: 0,
      lowEnergyRoutine: 0,
      duplicateTargetsSuppressed: 1,
      creepTargets: ["container-source"],
    });
    expect(actual.telemetry.emergencyReservePreserved).toBe(true);
    expect(actual.telemetry.duplicateTargetsSuppressed).toBeGreaterThan(0);
    expect(actual.telemetry.towers.failed).toBe(1);

    expect(actual.reconciliation).toMatchObject({
      repeatedRetirements: 0,
      workOutcomes: ["overshoot", "retired", "satisfied"],
      changedBandTarget: 200_000,
    });
    expect(actual.reconciliation.retirementCounts).toEqual([
      { contractId: "changed-band", count: 1 },
      { contractId: "lost-target", count: 1 },
      { contractId: "overshoot", count: 1 },
      { contractId: "satisfied", count: 1 },
    ]);
    expect(actual.telemetry.work).toEqual({ overshoot: 1, retired: 1, satisfied: 1 });

    expect(actual.equivalence).toMatchObject({
      contractsIdentical: true,
      retirementsIdentical: true,
      commandsIdentical: true,
      telemetryIdentical: true,
      semanticBytesIdentical: true,
      evidenceHashesIdentical: true,
    });
    expect(new Set(Object.values(actual.equivalence.hashes))).toHaveLength(1);
    expect(actual.bounds).toEqual({
      ticks: 12,
      maximumCpuPerTick: 1,
      maximumMaintenanceRequestsPerTick: 2,
      maximumPlannerEnergyPerTick: 400,
      maximumTowerCommandsPerTick: 1,
    });
  });
});
