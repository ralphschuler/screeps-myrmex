import { describe, expect, it } from "vitest";
import {
  ContractLedger,
  serializeContractLedgerState,
  type WorkContractRequest,
} from "../src/contracts";

describe("versioned contract persistence", () => {
  it("round-trips canonical stationary harvest terms across a reset", () => {
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected initialized contract ledger");
    const submitted = opened.ledger.submit(stationaryHarvest(), 10);
    expect(submitted).toMatchObject({ accepted: true, outcome: "created" });

    const serialized = serializeContractLedgerState(opened.ledger.view());
    const active = serialized.active as unknown as Array<{ execution: Record<string, unknown> }>;
    expect(active[0]?.execution).toEqual({
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      resourceType: null,
      version: 2,
      workPosition: { roomName: "W1N1", x: 11, y: 10 },
    });
    expect(active[0]?.execution).not.toHaveProperty("completionHits");

    const resetBytes = JSON.parse(JSON.stringify(serialized)) as unknown;
    const reopened = ContractLedger.open(resetBytes);
    expect(reopened.status).toBe("ready");
    if (reopened.status !== "ready") throw new Error("expected V2 owner to survive reset");
    expect(serializeContractLedgerState(reopened.ledger.view())).toEqual(serialized);
    expect(reopened.ledger.planningView().contracts[0]?.execution).toEqual(active[0]?.execution);
  });

  it("round-trips resource-specific V3 haul terms", () => {
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected initialized contract ledger");
    const request = stationaryHarvest();
    const haul: WorkContractRequest = {
      ...request,
      budgetBinding: { category: "harvesting-filling", issuer: "logistics/flow/acquire" },
      execution: {
        action: "pickup",
        completion: "target-depleted",
        counterpartId: "spawn-1",
        flowId: "flow-1",
        recommendedCarry: 2,
        recommendedMove: 2,
        reservedAmount: 80,
        resourceType: "energy",
        stage: "acquire",
        version: 3,
      },
      issuer: "logistics/flow",
      issuerKey: "0/acquire",
      kind: "haul",
      quantity: 80,
      requiredCapability: { ...request.requiredCapability, carry: 1, move: 1, work: 0 },
      targetId: "drop-1",
    };
    expect(opened.ledger.submit(haul, 10)).toMatchObject({ accepted: true });
    expect(opened.ledger.populationView()).toEqual({ loads: [], status: "ready" });
    const contractId = opened.ledger.view().active[0]?.id;
    if (contractId === undefined) throw new Error("expected proposed V3 contract");
    const funded = opened.ledger.reconcile({
      actors: [],
      funding: {
        authorizations: [
          {
            category: "harvesting-filling",
            colonyId: "W1N1",
            expiresAt: 999,
            issuer: "logistics/flow/acquire",
            reservationId: "reservation:logistics-flow",
            revision: 1,
            status: "active",
          },
        ],
        owners: [{ id: "W1N1", visibility: "visible" }],
        status: "ready",
      },
      requests: [],
      tick: 11,
      transitions: [{ contractId, reason: "logistics-funded", tick: 11, to: "funded" }],
      travel: { estimate: () => null },
    });
    expect(funded.transitions).toEqual([
      { accepted: true, contractId, from: "proposed", to: "funded" },
    ]);
    expect(opened.ledger.populationView()).toEqual({
      loads: [
        expect.objectContaining({
          category: "harvesting-filling",
          contractId,
          mode: "logistics",
          objectiveId: "logistics/flow/acquire",
          reservationId: contractId,
        }),
      ],
      status: "ready",
    });
    expect(opened.ledger.populationView().loads[0]?.minimumCapability).toMatchObject({
      carry: 2,
      move: 2,
    });
    const serialized = serializeContractLedgerState(opened.ledger.view());
    const reopened = ContractLedger.open(JSON.parse(JSON.stringify(serialized)) as unknown);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready")
      expect(serializeContractLedgerState(reopened.ledger.view())).toEqual(serialized);
  });
});

function stationaryHarvest(): WorkContractRequest {
  return {
    budgetBinding: { category: "harvesting-filling", issuer: "mining/W1N1/source-a" },
    conditions: {
      cancellation: "source-replaced",
      failure: "bounded-suspension",
      success: "continuous",
    },
    deadline: 999,
    earliestStart: 0,
    estimatedWorkTicks: 50,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      resourceType: null,
      version: 2,
      workPosition: { roomName: "W1N1", x: 11, y: 10 },
    },
    expiresAt: 1_000,
    issuer: "mining/W1N1/source-a",
    issuerKey: "source-a",
    issuerSequence: 1,
    kind: "harvest",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 3 },
    maxAssignmentCost: 150,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: ["visible-source", "fresh-source-service"],
    priority: { class: "survival", value: 950 },
    quantity: 50,
    range: 1,
    requiredCapability: {
      attack: 0,
      carry: 0,
      claim: 0,
      heal: 0,
      move: 3,
      rangedAttack: 0,
      tough: 0,
      work: 5,
    },
    target: { roomName: "W1N1", x: 10, y: 10 },
    targetId: "source-a",
  };
}
