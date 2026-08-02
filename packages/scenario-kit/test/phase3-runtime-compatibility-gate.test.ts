import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installMatureRuntimeGlobals } from "../../bot/test/support/mature-runtime-fixture";
import { collectPhase3CurrentRuntimeCompatibilityReceipt } from "./fixtures/phase3-production-portfolio-soak";

describe("Phase 3 current-runtime portfolio compatibility", () => {
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

  it("keeps the accepted remote behavior under the v29 production bundle", async () => {
    const receipt = await collectPhase3CurrentRuntimeCompatibilityReceipt();

    expect(receipt).toMatchObject({
      id: "phase3/portfolio/current-runtime-compatibility-v1",
      executor: "packages/bot/src/runtime/tick.runTick",
      executedVariants: ["warm", "reset", "reordered"],
      ticksPerVariant: [30, 30, 30],
      totalExecutedTicks: 90,
      memoryResetObserved: true,
      runtimeConfigSourceRevision: "runtime-config-source-v29",
      runtimePolicyRevision: "fnv1a64-utf16:2fa13822451badb4",
      finalActiveRooms: ["W1N3"],
      kernelFaults: 0,
      maximumActiveRemoteBudgetReservations: 5,
      maximumRemoteContracts: 6,
      maximumReservedCpuMilli: 300,
      maximumReservedEnergy: 6_800,
      maximumReservedMemoryCodeUnits: 4_352,
      maximumReservedSpawnTicks: 312,
      expectedCommandErrors: 1,
      scheduledRemoteSpawnCommands: 2,
      minimumProtectedEnergy: 300,
    });
    expect(new Set(Object.values(receipt.semanticHashes))).toEqual(
      new Set(["fnv1a64-utf16:77f8f5140411e87d"]),
    );
    expect(receipt.maximumPersistentBytes).toBeLessThanOrEqual(65_536);
    expect(receipt.maximumRemotesOwnerBytes).toBeLessThanOrEqual(32_768);
    const states = receipt.stateRows.flat();
    const reasons = receipt.reasonRows.flat();
    expect(states).toContain("W1N2:threatened");
    expect(states).toContain("W1N2:suspended");
    expect(states).toContain("W1N2:retired");
    expect(states).toContain("W1N3:active");
    expect(reasons).toContain("W1N2:threat-risk");
    expect(reasons).toContain("W1N2:negative-value");
    expect(reasons).toContain("W1N2:route-unavailable");
    expect(reasons).toContain("W1N2:intel-unavailable");
    expect(reasons).toContain("W1N2:source-vanished");
    expect(reasons).toContain("W1N3:capacity-cpu");
    expect(reasons).toContain("W1N3:donor-pressure");
  }, 20_000);
});
