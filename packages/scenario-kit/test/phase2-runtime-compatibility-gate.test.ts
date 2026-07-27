import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installMatureRuntimeGlobals } from "../../bot/test/support/mature-runtime-fixture";
import { collectPhase2ProductionLayoutRuntimeReceipt } from "./fixtures/phase2-production-layout-build";
import { collectPhase2ProductionMatureRuntimeReceipt } from "./fixtures/phase2-production-mature-runtime";

describe("Phase 2 current production-runtime compatibility", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", 101);
    vi.stubGlobal("FIND_HOSTILE_CREEPS", 102);
    vi.stubGlobal("FIND_SOURCES", 105);
    vi.stubGlobal("FIND_DROPPED_RESOURCES", 106);
    vi.stubGlobal("FIND_STRUCTURES", 107);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", 111);
    installMatureRuntimeGlobals();
  });

  afterAll(() => vi.unstubAllGlobals());

  it("executes commandful RCL3 and RCL8 paths through production runTick", async () => {
    const layout = await collectPhase2ProductionLayoutRuntimeReceipt();
    const mature = await collectPhase2ProductionMatureRuntimeReceipt();

    expect(layout).toMatchObject({
      command: { callsPerVariant: 4, energyPerVariant: 100, kind: "Creep.build" },
      completeColonySoak: false,
      controllerLevel: 3,
      executedVariants: ["warm", "reset", "reordered"],
      executor: "packages/bot/src/runtime/tick.runTick",
      kernelFaults: 0,
      memoryResetObserved: true,
      ticksPerVariant: [7, 7, 7],
      totalExecutedTicks: 21,
      worldStateSettled: true,
    });
    expect(new Set(Object.values(layout.semanticHashes))).toHaveLength(1);

    expect(mature).toMatchObject({
      accounting: {
        factory: [40, 100, 20],
        powerProcessing: [50, 1, 1],
      },
      commands: [
        { callsPerVariant: 1, kind: "StructureFactory.produce" },
        { callsPerVariant: 1, kind: "StructurePowerSpawn.processPower" },
      ],
      completeColonySoak: false,
      controllerLevel: 8,
      executedVariants: ["warm", "reset", "reordered"],
      executor: "packages/bot/src/runtime/tick.runTick",
      healthObservation: {
        blockerDomain: "layout",
        colonyStates: ["developing", "developing", "developing"],
      },
      kernelFaults: 0,
      memoryResetObserved: true,
      settled: true,
      ticksPerVariant: [3, 3, 3],
      totalExecutedTicks: 9,
    });
    expect(new Set(Object.values(mature.semanticHashes))).toHaveLength(1);
    expect(layout.totalExecutedTicks + mature.totalExecutedTicks).toBe(30);
  });
});
