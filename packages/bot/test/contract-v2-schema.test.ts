import { describe, expect, it } from "vitest";
import {
  ContractLedger,
  contractIdFor,
  contractOutcomeRequestDigest,
  normalizeContractRequest,
  requestSignature,
  serializeContractLedgerState,
  type WorkContractRequest,
} from "../src/contracts";

describe("versioned contract persistence", () => {
  it("migrates V1 active signatures to tuple V3 without changing behavior", () => {
    const request = normalizeContractRequest(stationaryHarvest());
    const created = ContractLedger.open({});
    if (created.status !== "ready") throw new Error("expected initialized contract ledger");
    expect(created.ledger.submit(request, 10)).toMatchObject({
      accepted: true,
      outcome: "created",
    });

    const current = created.ledger.view();
    const previous = ContractLedger.open(JSON.parse(JSON.stringify(current)) as unknown);
    expect(previous.status).toBe("ready");
    if (previous.status !== "ready") throw new Error("expected V2 contract owner to migrate");
    expect(previous.ledger.changed).toBe(true);
    expect(previous.ledger.planningView()).toEqual(created.ledger.planningView());
    const legacy = {
      ...current,
      active: current.active.map((record) => ({
        ...record,
        history: record.history.map(([from, reason, tick, to]) => ({ from, reason, tick, to })),
        requestSignature: requestSignature(record),
      })),
      schemaVersion: 1,
    };
    const legacyBytes = JSON.stringify(legacy);
    const migrated = ContractLedger.open(JSON.parse(legacyBytes) as unknown);
    expect(migrated.status).toBe("ready");
    if (migrated.status !== "ready") throw new Error("expected V1 contract owner to migrate");
    expect(migrated.ledger.changed).toBe(true);
    expect(migrated.ledger.planningView().contracts[0]?.requestSignature).toBe(
      requestSignature(request),
    );
    expect(migrated.ledger.submit(request, 11)).toMatchObject({
      accepted: true,
      outcome: "duplicate-active",
    });
    expect(
      migrated.ledger.submit({ ...request, quantity: request.quantity + 1 }, 11),
    ).toMatchObject({
      accepted: false,
      reason: "idempotency-conflict",
    });

    const serialized = serializeContractLedgerState(migrated.ledger.view());
    expect(serialized.schemaVersion).toBe(3);
    expect((serialized.active as unknown[])[0]).toBeInstanceOf(Array);
    expect((serialized.active as unknown[])[0]).not.toHaveProperty("requestSignature");
    expect(JSON.stringify(serialized).length).toBeLessThan(legacyBytes.length);

    const reset = ContractLedger.open(JSON.parse(JSON.stringify(serialized)) as unknown);
    expect(reset.status).toBe("ready");
    if (reset.status !== "ready") throw new Error("expected migrated V3 owner to survive reset");
    expect(reset.ledger.changed).toBe(false);
    expect(reset.ledger.view()).toEqual(migrated.ledger.view());
    expect(reset.ledger.planningView()).toEqual(migrated.ledger.planningView());
  });

  it("compacts V1 terminal identity and history without changing reset semantics", () => {
    const activeRequest = normalizeContractRequest(routedRemoteHarvest());
    const terminalRequest = normalizeContractRequest({
      ...stationaryHarvest(),
      budgetBinding: { category: "harvesting-filling", issuer: "cleanup/W1N1" },
      issuer: "cleanup/W1N1",
      issuerKey: "terminal-harvest",
      issuerSequence: 3,
    });
    const activeId = contractIdFor(
      activeRequest.issuer,
      activeRequest.issuerKey,
      activeRequest.issuerSequence,
    );
    const terminalId = contractIdFor(
      terminalRequest.issuer,
      terminalRequest.issuerKey,
      terminalRequest.issuerSequence,
    );
    const legacy = {
      active: [
        {
          ...activeRequest,
          history: [
            { from: null, reason: "issuer-requested", tick: 10, to: "proposed" },
            { from: "proposed", reason: "funded", tick: 11, to: "funded" },
            { from: "funded", reason: "assigned", tick: 12, to: "assigned" },
            { from: "assigned", reason: "command-issued", tick: 13, to: "active" },
            {
              from: "active",
              reason: "agent-unexpected-game-rejection",
              tick: 14,
              to: "suspended",
            },
          ],
          id: activeId,
          lease: null,
          requestSignature: requestSignature(activeRequest),
          revision: 5,
          state: "suspended",
        },
      ],
      issuerFrontiers: [{ issuer: terminalRequest.issuer, retiredThrough: 3 }],
      outcomes: [
        {
          id: terminalId,
          issuer: terminalRequest.issuer,
          issuerKey: terminalRequest.issuerKey,
          issuerSequence: terminalRequest.issuerSequence,
          reason: "test-cancelled",
          requestSignature: requestSignature(terminalRequest),
          revision: 2,
          state: "cancelled",
          tick: 15,
        },
      ],
      schemaVersion: 1,
    };
    const legacyBytes = JSON.stringify(legacy);
    const opened = ContractLedger.open(JSON.parse(legacyBytes) as unknown);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("expected V1 contract owner to migrate");
    expect(opened.ledger.changed).toBe(true);
    expect(opened.ledger.planningView().contracts[0]?.remoteMiningRetry).toEqual({
      attempts: 1,
      eligibleAt: 14,
    });
    expect(opened.ledger.submit(terminalRequest, 16)).toMatchObject({
      accepted: true,
      outcome: "duplicate-terminal",
    });
    expect(
      opened.ledger.submit({ ...terminalRequest, quantity: terminalRequest.quantity + 1 }, 16),
    ).toMatchObject({ accepted: false, reason: "idempotency-conflict" });

    const serialized = serializeContractLedgerState(opened.ledger.view());
    const active = serialized.active as unknown as unknown[][];
    const outcomes = serialized.outcomes as unknown as unknown[][];
    expect(active[0]?.[21]).toEqual([
      null,
      [
        ["issuer-requested", 10, "proposed"],
        ["funded", 11, "funded"],
        ["assigned", 12, "assigned"],
        ["command-issued", 13, "active"],
        ["agent-unexpected-game-rejection", 14, "suspended"],
      ],
    ]);
    expect(outcomes[0]?.[4]).toBe(contractOutcomeRequestDigest(terminalRequest));
    const compactBytes = JSON.stringify(serialized).length;
    expect(compactBytes).toBeLessThan(legacyBytes.length);
    expect(legacyBytes.length - compactBytes).toBeGreaterThan(2_000);

    const reset = ContractLedger.open(JSON.parse(JSON.stringify(serialized)) as unknown);
    expect(reset.status).toBe("ready");
    if (reset.status !== "ready") throw new Error("expected compact V3 owner to survive reset");
    expect(reset.ledger.changed).toBe(false);
    expect(reset.ledger.view()).toEqual(opened.ledger.view());
    expect(reset.ledger.planningView()).toEqual(opened.ledger.planningView());
    expect(reset.ledger.submit(terminalRequest, 17)).toMatchObject({
      accepted: true,
      outcome: "duplicate-terminal",
    });
    expect(
      reset.ledger.submit({ ...terminalRequest, quantity: terminalRequest.quantity + 1 }, 17),
    ).toMatchObject({ accepted: false, reason: "idempotency-conflict" });

    const malformedDigest = JSON.parse(JSON.stringify(serialized)) as { outcomes: unknown[][] };
    const compactOutcome = malformedDigest.outcomes[0];
    if (compactOutcome === undefined) throw new Error("expected compact terminal outcome");
    compactOutcome[4] = "contract-request-v1:fnv1a64-utf16:not-a-digest";
    const invalidDigest = ContractLedger.open(malformedDigest);
    expect(invalidDigest.status).toBe("invalid");
    if (invalidDigest.status === "invalid")
      expect(invalidDigest.error).toMatchObject({
        code: "invalid-outcome-request-digest",
        path: "$.outcomes[0].requestSignature",
      });

    const nonCanonicalLegacy = JSON.parse(legacyBytes) as {
      outcomes: Array<{ requestSignature: string }>;
    };
    const legacyOutcome = nonCanonicalLegacy.outcomes[0];
    if (legacyOutcome === undefined) throw new Error("expected V1 terminal outcome");
    const decoded = JSON.parse(legacyOutcome.requestSignature) as Record<string, unknown>;
    const { issuer, ...remaining } = decoded;
    legacyOutcome.requestSignature = JSON.stringify({ issuer, ...remaining });
    const invalidLegacy = ContractLedger.open(nonCanonicalLegacy);
    expect(invalidLegacy.status).toBe("invalid");
    if (invalidLegacy.status === "invalid")
      expect(invalidLegacy.error).toMatchObject({
        code: "invalid-outcome-request-signature",
        path: "$.outcomes[0].requestSignature",
      });
  });

  it("keeps strict V1 signature validation and terminal digests in V3", () => {
    const request = normalizeContractRequest(stationaryHarvest());
    const id = contractIdFor(request.issuer, request.issuerKey, request.issuerSequence);
    const legacy = {
      active: [
        {
          ...request,
          history: [{ from: null, reason: "issuer-requested", tick: 10, to: "proposed" }],
          id,
          lease: null,
          requestSignature: requestSignature({ ...request, quantity: request.quantity + 1 }),
          revision: 1,
          state: "proposed",
        },
      ],
      issuerFrontiers: [],
      outcomes: [],
      schemaVersion: 1,
    };
    const invalid = ContractLedger.open(legacy);
    expect(invalid.status).toBe("invalid");
    if (invalid.status === "invalid")
      expect(invalid.error).toMatchObject({
        code: "invalid-request-signature",
        path: "$.active[0].requestSignature",
      });

    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected initialized contract ledger");
    const submitted = opened.ledger.submit(request, 10);
    if (!submitted.accepted) throw new Error("expected contract submission");
    expect(
      opened.ledger.transition({
        contractId: submitted.contractId,
        reason: "test-complete",
        tick: 11,
        to: "cancelled",
      }),
    ).toMatchObject({ accepted: true });
    const serialized = serializeContractLedgerState(opened.ledger.view());
    expect(serialized.schemaVersion).toBe(3);
    expect(serialized.active).toEqual([]);
    expect((serialized.outcomes as unknown[][])[0]?.[4]).toBe(
      contractOutcomeRequestDigest(request),
    );
  });

  it("round-trips canonical stationary harvest terms across a reset", () => {
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected initialized contract ledger");
    const submitted = opened.ledger.submit(stationaryHarvest(), 10);
    expect(submitted).toMatchObject({ accepted: true, outcome: "created" });

    const serialized = serializeContractLedgerState(opened.ledger.view());
    const active = serialized.active as unknown as unknown[][];
    expect(serialized.schemaVersion).toBe(3);
    expect(active[0]).not.toHaveProperty("requestSignature");
    expect(active[0]?.[21]).toEqual([null, [["issuer-requested", 10, "proposed"]]]);
    expect(active[0]?.[3]).toEqual([2, "continuous", null, "W1N1", 11, 10]);

    const resetBytes = JSON.parse(JSON.stringify(serialized)) as unknown;
    const reopened = ContractLedger.open(resetBytes);
    expect(reopened.status).toBe("ready");
    if (reopened.status !== "ready") throw new Error("expected V3 owner to survive reset");
    expect(serializeContractLedgerState(reopened.ledger.view())).toEqual(serialized);
    expect(reopened.ledger.planningView().contracts[0]?.execution).toEqual(
      normalizeContractRequest(stationaryHarvest()).execution,
    );
  });

  it("round-trips routed V5 mining terms and derives bounded retry evidence", () => {
    const request = normalizeContractRequest(routedRemoteHarvest());
    const id = contractIdFor(request.issuer, request.issuerKey, request.issuerSequence);
    const opened = ContractLedger.open({
      active: [
        {
          ...request,
          history: [
            { from: null, reason: "issuer-requested", tick: 10, to: "proposed" },
            { from: "proposed", reason: "funded", tick: 11, to: "funded" },
            { from: "funded", reason: "assigned", tick: 12, to: "assigned" },
            { from: "assigned", reason: "command-issued", tick: 13, to: "active" },
            {
              from: "active",
              reason: "agent-unexpected-game-rejection",
              tick: 14,
              to: "suspended",
            },
          ],
          id,
          lease: null,
          requestSignature: requestSignature(request),
          revision: 5,
          state: "suspended",
        },
      ],
      issuerFrontiers: [],
      outcomes: [],
      schemaVersion: 1,
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("expected V5 owner to survive reset");
    expect(opened.ledger.planningView().contracts[0]).toEqual(
      expect.objectContaining({ remoteMiningRetry: { attempts: 1, eligibleAt: 14 } }),
    );
    const serialized = serializeContractLedgerState(opened.ledger.view());
    const reopened = ContractLedger.open(JSON.parse(JSON.stringify(serialized)) as unknown);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") {
      expect(serializeContractLedgerState(reopened.ledger.view())).toEqual(serialized);
      expect(reopened.ledger.planningView().contracts[0]?.remoteMiningRetry).toEqual({
        attempts: 1,
        eligibleAt: 14,
      });
    }
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

  it("keeps a production-sized active owner well below its V2 byte footprint", () => {
    const opened = ContractLedger.open({});
    if (opened.status !== "ready") throw new Error("expected initialized contract ledger");
    for (let index = 0; index < 22; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const issuer = `mining/W1N1/source-${suffix}`;
      expect(
        opened.ledger.submit(
          {
            ...stationaryHarvest(),
            budgetBinding: { category: "harvesting-filling", issuer },
            issuer,
            issuerKey: `source-${suffix}`,
            targetId: `source-${suffix}`,
          },
          10,
        ),
      ).toMatchObject({ accepted: true, outcome: "created" });
    }

    const v2 = opened.ledger.view();
    const v3 = serializeContractLedgerState(v2);
    const savedBytes = JSON.stringify(v2).length - JSON.stringify(v3).length;
    expect(v3.schemaVersion).toBe(3);
    expect(savedBytes).toBeGreaterThan(10_000);

    const reset = ContractLedger.open(JSON.parse(JSON.stringify(v3)) as unknown);
    expect(reset.status).toBe("ready");
    if (reset.status === "ready") {
      expect(reset.ledger.view()).toEqual(v2);
      expect(reset.ledger.planningView()).toEqual(opened.ledger.planningView());
    }
  });
});

function routedRemoteHarvest(): WorkContractRequest {
  return {
    ...stationaryHarvest(),
    budgetBinding: {
      category: "harvesting-filling",
      issuer: "remote-mining/W1N1/W1N2/source-a",
    },
    deadline: 999,
    execution: {
      action: "harvest",
      completion: "continuous",
      counterpartId: null,
      offload: "container-or-drop",
      originRoomName: "W1N1",
      resourceType: null,
      routeRoomNames: ["W1N2"],
      routeTravelTicks: 50,
      version: 5,
      workPosition: { roomName: "W1N2", x: 11, y: 10 },
    },
    expiresAt: 1_000,
    issuer: "remote-mining/W1N1/W1N2/source-a",
    issuerKey: "source-a",
    leasePolicy: { duration: 500, switchingPenalty: 50, ttlSafetyMargin: 25 },
    maxAssignmentCost: 50,
    priority: { class: "speculation", value: 700 },
    quantity: 300,
    target: { roomName: "W1N2", x: 10, y: 10 },
  };
}

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
