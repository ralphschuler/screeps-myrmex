import { describe, expect, it } from "vitest";
import checkedEvidence from "../../../docs/phase2-industry-results.json";
import { collectIndustryEvidence } from "./fixtures/phase2-industry";

describe("Phase 2 industry composed deterministic evidence (#50)", () => {
  it("matches checked evidence and proves the stock-policy acceptance matrix", () => {
    const actual = collectIndustryEvidence();

    expect(actual).toEqual(checkedEvidence);
    expect(actual.deterministicScenario).toMatchObject({
      ownedRcl6Rooms: 2,
      equivalentAfterWarmResetAndReorder: true,
      extraction: { fundedAmount: 300, fundedContracts: 1, unfundedProposals: 0 },
      terminal: {
        affordableSends: 1,
        expensiveSends: 0,
        expensiveReason: "insufficient-energy",
      },
      noGhostReservation: true,
    });
    expect(actual.recovery).toMatchObject({
      attempt: 1,
      nextEligibleTick: 1_002,
      resetEquivalent: true,
      statusAfterDestinationLoss: "retired",
    });
    expect(actual.accounting).toEqual({
      consumed: 300,
      hauled: 0,
      mined: 300,
      reserved: 300,
      sent: 200,
      transactionEnergy: 20,
      unmet: 0,
    });
    expect(actual.telemetry).toMatchObject({
      commands: { executed: 0, failed: 0, rejected: 1 },
      stateCount: 1,
    });
    expect(actual.boundaries).toEqual({
      commandExecutors: ["terminal.send"],
      maximumExtractionProposals: 2,
      maximumSendProposals: 1,
      maximumRoomsScanned: 2,
      nonGoals: ["market orders", "remote minerals", "labs", "factories"],
    });
  });
});
