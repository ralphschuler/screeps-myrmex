import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../src/colony";
import { ContractLedger, type ContractPlanningView } from "../src/contracts";
import type { ArbitrationBatch } from "../src/execution";
import {
  authorizeIndustryWork,
  eligibleIndustrySendIds,
  executeTerminalSendIntents,
  observeIndustryRooms,
  projectIndustryBudgets,
  projectIndustryLabBudgets,
  projectIndustryTelemetry,
  projectIndustryTerminalWork,
  projectTerminalSendIntents,
  reconcileIndustryCommands,
  type IndustryPlan,
  type TerminalSendIntent,
} from "../src/industry";
import {
  unpublishedIndustryReservationIds,
  type IndustryPublicationEvidence,
} from "../src/runtime/tick";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("industry runtime authority chain", () => {
  it("detaches current industry state and authorizes funded extraction at the observed mineral", () => {
    const rooms = observeIndustryRooms(snapshot(), [
      {
        bands: [{ resourceType: "H", min: 100, target: 500, max: 800 }],
        commitments: [{ amount: 300, fundedAmount: 200, id: "labs/H", resourceType: "H" }],
        protectedEnergy: 300,
        roomName: "W1N1",
      },
    ]);

    expect(rooms[0]).toMatchObject({
      controllerLevel: 6,
      extractor: { active: true, cooldown: 0 },
      mineral: { amount: 10_000, id: "mineral", resourceType: "H" },
      terminal: { active: true, cooldown: 0, freeCapacity: 2_000 },
    });
    const plan = industryPlan();
    const budgets = projectIndustryBudgets(plan, 100);
    expect(budgets.map(({ category, issuer }) => ({ category, issuer }))).toEqual([
      { category: "industry", issuer: "industry/extract/W1N1/mineral/H" },
      { category: "industry", issuer: "industry/send/request/W1N1/W2N2/H" },
    ]);
    expect(budgets.map(({ cpu }) => cpu)).toEqual([
      { minimum: 100, desired: 500 },
      { minimum: 20, desired: 100 },
    ]);
    const authorized = authorizeIndustryWork({
      contracts: { contracts: [], issuerFrontiers: [], status: "ready" },
      plan,
      reservations: [reservation(required(budgets[0]))],
      rooms,
      tick: 100,
    });
    expect(authorized.extractionContracts).toHaveLength(1);
    expect(authorized.extractionContracts[0]).toMatchObject({
      budgetBinding: { category: "industry", issuer: "industry/extract/W1N1/mineral/H" },
      execution: { action: "harvest", resourceType: null, version: 1 },
      target: { roomName: "W1N1", x: 20, y: 21 },
      targetId: "mineral",
    });
  });

  it("keeps active extraction stable and regenerates once after terminal retirement", () => {
    const rooms = observeIndustryRooms(snapshot(), [
      {
        bands: [{ resourceType: "H", min: 100, target: 500, max: 800 }],
        commitments: [],
        protectedEnergy: 300,
        roomName: "W1N1",
      },
    ]);
    const plan = industryPlan();
    const initialBudget = required(projectIndustryBudgets(plan, 100)[0]);
    const activeBudget = reservation(initialBudget);
    expect(required(projectIndustryBudgets(plan, 101, [activeBudget])[0])).toEqual(initialBudget);
    expect(required(projectIndustryBudgets(plan, 119, [activeBudget])[0])).toMatchObject({
      expiresAt: 139,
      revision: 2,
    });

    const empty: ContractPlanningView = {
      contracts: [],
      issuerFrontiers: [],
      status: "ready",
    };
    const initial = authorizeIndustryWork({
      contracts: empty,
      plan,
      reservations: [activeBudget],
      rooms,
      tick: 100,
    });
    const request = required(initial.extractionContracts[0]);
    expect(request.issuerSequence).toBe(1);

    const activeRecord: ContractPlanningView["contracts"][number] = {
      budgetBinding: request.budgetBinding,
      contractId: "industry-active",
      execution: required(request.execution),
      issuer: request.issuer,
      issuerSequence: request.issuerSequence,
      owner: request.owner,
      state: "active",
      targetId: required(request.targetId ?? undefined),
    };
    expect(
      authorizeIndustryWork({
        contracts: { contracts: [activeRecord], issuerFrontiers: [], status: "ready" },
        plan,
        reservations: [activeBudget],
        rooms,
        tick: 101,
      }).extractionContracts,
    ).toEqual([]);

    const retired: ContractPlanningView = {
      contracts: [],
      issuerFrontiers: [{ issuer: request.issuer, retiredThrough: 1 }],
      status: "ready",
    };
    const successor = authorizeIndustryWork({
      contracts: retired,
      plan,
      reservations: [activeBudget],
      rooms,
      tick: 102,
    });
    expect(successor.extractionContracts).toHaveLength(1);
    expect(successor.extractionContracts[0]?.issuerSequence).toBe(2);
    const successorRequest = required(successor.extractionContracts[0]);
    const opened = ContractLedger.open({
      active: [],
      issuerFrontiers: [{ issuer: request.issuer, retiredThrough: 1 }],
      outcomes: [],
      schemaVersion: 1,
    });
    if (opened.status !== "ready") throw new Error("expected industry ledger");
    const submission = opened.ledger.submit(successorRequest, 102);
    if (!submission.accepted) throw new Error(`industry successor rejected: ${submission.reason}`);
    expect(submission).toMatchObject({
      accepted: true,
      outcome: "created",
    });
    expect(opened.ledger.submit(successorRequest, 102)).toMatchObject({
      accepted: true,
      outcome: "duplicate-active",
    });
    expect(
      authorizeIndustryWork({
        ...roundTrip({
          contracts: retired,
          plan,
          reservations: [activeBudget],
          rooms,
          tick: 102,
        }),
      }),
    ).toEqual(successor);

    const proposed = { ...activeRecord, state: "proposed" as const };
    expect(
      authorizeIndustryWork({
        contracts: { contracts: [proposed], issuerFrontiers: [], status: "ready" },
        plan,
        reservations: [activeBudget],
        rooms,
        tick: 103,
      }),
    ).toMatchObject({
      extractionContracts: [],
      transitions: [
        {
          contractId: "industry-active",
          reason: "industry-extraction-funded",
          tick: 103,
          to: "funded",
        },
      ],
    });
  });

  it("fails closed when extraction contract planning is unavailable", () => {
    const rooms = observeIndustryRooms(snapshot(), [
      {
        bands: [{ resourceType: "H", min: 100, target: 500, max: 800 }],
        commitments: [],
        protectedEnergy: 300,
        roomName: "W1N1",
      },
    ]);
    const plan = industryPlan();
    const budgets = projectIndustryBudgets(plan, 100);
    const authorized = authorizeIndustryWork({
      contracts: { contracts: [], issuerFrontiers: [], status: "unavailable" },
      plan,
      reservations: [reservation(required(budgets[0]))],
      rooms,
      tick: 100,
    });

    expect(authorized.budgets).toEqual(budgets);
    expect(authorized.extractionContracts).toEqual([]);
    expect(authorized.transitions).toEqual([]);
  });

  it("settles only current executable Industry bindings without touching lab budgets", () => {
    const plan = industryPlan();
    const extractionIssuer = required(plan.extraction[0]).identity;
    const terminalIssuer = required(plan.sends[0]).identity;
    const extractionReservation = settlementReservation("extraction", extractionIssuer, 90);
    const terminalReservation = settlementReservation("terminal", terminalIssuer, 90);
    const labReservation = settlementReservation("lab", "industry/boost/compound", 90);
    const liveExtraction = exactExtractionPlanningRecord();
    const currentEvidence: IndustryPublicationEvidence = {
      extractionBootstraps: [
        {
          colonyId: "W1N1",
          createdAtTick: 100,
          issuer: extractionIssuer,
          mineralId: "mineral",
        },
      ],
      terminalIntents: [
        {
          colonyId: "W1N1",
          issuer: terminalIssuer,
          publishedAtTick: 100,
        },
      ],
    };

    expect(
      unpublishedIndustryReservationIds({
        contracts: {
          contracts: [liveExtraction],
          issuerFrontiers: [],
          status: "ready",
        },
        evidence: { extractionBootstraps: [], terminalIntents: [] },
        plan,
        reservations: [terminalReservation, labReservation, extractionReservation],
        tick: 100,
      }),
    ).toEqual(["terminal"]);

    expect(
      unpublishedIndustryReservationIds({
        contracts: { contracts: [], issuerFrontiers: [], status: "ready" },
        evidence: currentEvidence,
        plan,
        reservations: [
          { ...extractionReservation, createdAt: 100 },
          terminalReservation,
          labReservation,
        ],
        tick: 100,
      }),
    ).toEqual([]);

    expect(
      unpublishedIndustryReservationIds({
        contracts: { contracts: [], issuerFrontiers: [], status: "ready" },
        evidence: currentEvidence,
        plan,
        reservations: [extractionReservation],
        tick: 100,
      }),
    ).toEqual([]);

    expect(
      unpublishedIndustryReservationIds({
        contracts: { contracts: [], issuerFrontiers: [], status: "ready" },
        evidence: {
          extractionBootstraps: [
            {
              ...required(currentEvidence.extractionBootstraps[0]),
              createdAtTick: 99,
            },
          ],
          terminalIntents: [
            {
              ...required(currentEvidence.terminalIntents[0]),
              publishedAtTick: 99,
            },
          ],
        },
        plan,
        reservations: [
          { ...extractionReservation, createdAt: 100 },
          terminalReservation,
          labReservation,
        ],
        tick: 100,
      }),
    ).toEqual(["extraction", "terminal"]);

    expect(
      unpublishedIndustryReservationIds({
        contracts: { contracts: [], issuerFrontiers: [], status: "unavailable" },
        evidence: currentEvidence,
        plan,
        reservations: [
          extractionReservation,
          { ...extractionReservation, createdAt: 100, reservationId: "new-extraction" },
          terminalReservation,
          labReservation,
        ],
        tick: 100,
      }),
    ).toEqual(["new-extraction"]);

    expect(
      unpublishedIndustryReservationIds({
        contracts: {
          contracts: [{ ...liveExtraction, targetId: "different-mineral" }],
          issuerFrontiers: [],
          status: "ready",
        },
        evidence: { extractionBootstraps: [], terminalIntents: [] },
        plan,
        reservations: [extractionReservation],
        tick: 100,
      }),
    ).toEqual(["extraction"]);
  });

  it("executes only accepted terminal intents and normalizes missing terminals", () => {
    const intents = projectTerminalSendIntents({
      plan: industryPlan(),
      reservations: [reservation(required(projectIndustryBudgets(industryPlan(), 100)[1]))],
      terminalIds: new Map([["W1N1", "terminal"]]),
      tick: 100,
    });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      exclusiveResourceKey: "terminal/terminal",
      kind: "terminal.send",
      payload: { amount: 200, destinationRoom: "W2N2" },
    });
    const send = vi.fn(() => 0);
    const success = executeTerminalSendIntents(
      batch(intents),
      100,
      () => ({ send }) as unknown as StructureTerminal,
    );
    expect(send).toHaveBeenCalledWith("H", 200, "W2N2");
    expect(success[0]).toMatchObject({ reason: "OK", returnCode: 0, status: "executed" });

    const missing = executeTerminalSendIntents(batch(intents), 100, () => null);
    expect(missing[0]).toMatchObject({
      reason: "ERR_INVALID_TARGET",
      returnCode: -7,
      status: "rejected",
    });

    const firstIntent = intents[0];
    if (firstIntent === undefined) throw new Error("expected projected terminal intent");
    const mixed = executeTerminalSendIntents(
      {
        ...batch(intents),
        accepted: [...intents, { ...firstIntent, id: "move/other", kind: "creep.move" }],
        submitted: 2,
      },
      100,
      () => ({ send }) as unknown as StructureTerminal,
    );
    expect(mixed).toHaveLength(1);
  });

  it("reconciles failures into bounded backoff and deterministic telemetry", () => {
    const plan = industryPlan();
    const intents = projectTerminalSendIntents({
      plan,
      reservations: [reservation(required(projectIndustryBudgets(plan, 100)[1]))],
      terminalIds: new Map([["W1N1", "terminal"]]),
      tick: 100,
    });
    const failed = executeTerminalSendIntents(batch(intents), 100, () => null);
    const first = reconcileIndustryCommands({ plan, previous: [], results: failed, tick: 100 });
    expect(first).toEqual([
      expect.objectContaining({ attempt: 1, nextEligibleTick: 102, status: "backoff" }),
    ]);
    expect(
      eligibleIndustrySendIds(
        plan.sends.map(({ identity }) => identity),
        first,
        101,
      ),
    ).toEqual([]);
    expect(
      eligibleIndustrySendIds(
        plan.sends.map(({ identity }) => identity),
        first,
        102,
      ),
    ).toEqual(["industry/send/request/W1N1/W2N2/H"]);
    const firstState = first[0];
    if (firstState === undefined) throw new Error("expected reconciled industry command state");
    expect(
      eligibleIndustrySendIds(
        plan.sends.map(({ identity }) => identity),
        [{ ...firstState, status: "completed" }],
        200,
      ),
    ).toEqual([]);
    const reordered = reconcileIndustryCommands({
      plan,
      previous: roundTrip([...first].reverse()),
      results: [...failed].reverse(),
      tick: 102,
    });
    expect(reordered[0]).toMatchObject({ attempt: 2, nextEligibleTick: 106 });
    expect(projectIndustryTelemetry({ plan, results: failed, states: first })).toMatchObject({
      accounting: { mined: 200, reserved: 300, sent: 200, transactionEnergy: 20 },
      commands: { executed: 0, failed: 0, rejected: 1 },
      extractionProposals: 1,
      sendProposals: 1,
    });
  });

  it("publishes deterministic fail-closed terminal work for layout consumers", () => {
    const plan = industryPlan();
    const projected = projectIndustryTerminalWork({
      plan,
      previous: [],
      roomNames: ["W3N3", "W2N2", "W1N1"],
    });
    expect(projected).toEqual({
      rooms: [
        { roomName: "W1N1", status: "active" },
        { roomName: "W2N2", status: "active" },
        { roomName: "W3N3", status: "quiescent" },
      ],
      status: "available",
    });
    expect(
      projectIndustryTerminalWork({
        plan: { ...plan, sends: [] },
        previous: [
          {
            attempt: 1,
            identity: plan.sends[0]?.identity ?? "missing",
            lastCode: "ERR_TIRED",
            nextEligibleTick: 105,
            status: "backoff",
          },
        ],
        roomNames: ["W2N2", "W1N1"],
      }),
    ).toEqual({ rooms: [], status: "unavailable" });
    expect(
      JSON.stringify(
        projectIndustryTerminalWork({
          plan,
          previous: [],
          roomNames: ["W3N3", "W1N1", "W2N2"],
        }),
      ),
    ).toBe(JSON.stringify(projected));
    expect(
      projectIndustryTerminalWork({
        plan,
        previous: [],
        roomNames: Array.from({ length: 65 }, (_, index) => `W${String(index)}N1`),
      }),
    ).toEqual({ rooms: [], status: "unavailable" });
  });

  it("funds every lab staging demand independently without authorizing work", () => {
    const budgets = projectIndustryLabBudgets(
      {
        blockers: [],
        commitments: [],
        dispositions: [],
        budgets: [
          {
            colonyId: "W1N1",
            deadline: 150,
            demandId: "compound",
            identity: "industry/boost/compound",
            priority: "mandatory",
          },
          {
            colonyId: "W1N1",
            deadline: 150,
            demandId: "energy",
            identity: "industry/boost/energy",
            priority: "mandatory",
          },
        ],
        demands: [labDemand("compound", "XUH2O", 60), labDemand("energy", "energy", 40)],
      },
      100,
    );

    expect(budgets.map(({ issuer }) => issuer)).toEqual([
      "industry/boost/compound",
      "industry/boost/energy",
    ]);
    expect(budgets.map(({ energy }) => energy)).toEqual([
      { minimum: 0, desired: 0 },
      { minimum: 40, desired: 40 },
    ]);
    expect(budgets.map(({ cpu }) => cpu)).toEqual([
      { minimum: 50, desired: 250 },
      { minimum: 50, desired: 250 },
    ]);
  });
});

function labDemand(id: string, resourceType: string, amount: number) {
  return {
    amount,
    clusterFingerprint: "cluster-v1",
    colonyId: "W1N1",
    deadline: 150,
    endpointId: "storage",
    id,
    industryBudgetId: `industry/boost/${id}`,
    labId: "lab-c",
    mode: "fill" as const,
    priority: "mandatory" as const,
    resourceType,
    revision: 1,
  };
}

function industryPlan(): IndustryPlan {
  return {
    accounting: {
      consumed: 300,
      hauled: 0,
      mined: 200,
      reserved: 300,
      sent: 200,
      transactionEnergy: 20,
      unmet: 0,
    },
    deferrals: [],
    extraction: [
      {
        amount: 200,
        identity: "industry/extract/W1N1/mineral/H",
        mineralId: "mineral",
        resourceType: "H",
        roomName: "W1N1",
      },
    ],
    scannedRooms: 2,
    scannedSendRequests: 1,
    sends: [
      {
        amount: 200,
        deadline: 110,
        destinationRoom: "W2N2",
        identity: "industry/send/request/W1N1/W2N2/H",
        requestId: "request",
        resourceType: "H",
        sourceRoom: "W1N1",
        transactionEnergy: 20,
      },
    ],
  };
}

function batch(
  intents: readonly TerminalSendIntent[],
): ArbitrationBatch<"terminal.send", TerminalSendIntent["payload"]> {
  return {
    accepted: intents,
    acceptedBudget: 20,
    decisions: [],
    submitted: intents.length,
    tick: 100,
  };
}

function reservation(request: ReturnType<typeof projectIndustryBudgets>[number]): LedgerEntry {
  return {
    reservationId: `reservation/${request.issuer}`,
    colonyId: request.colonyId,
    category: request.category,
    issuer: request.issuer,
    revision: request.revision,
    request,
    reasonCode: "granted",
    grant: { energy: 800, cpu: request.cpu?.desired ?? 0, spawn: null },
    consumed: { energy: 0, cpu: 0, spawn: false },
    createdAt: 100,
    updatedAt: 100,
    status: "active",
  };
}

function settlementReservation(reservationId: string, issuer: string, createdAt: number) {
  return {
    category: "industry",
    colonyId: "W1N1",
    createdAt,
    issuer,
    reservationId,
    status: "active",
  };
}

function exactExtractionPlanningRecord(): ContractPlanningView["contracts"][number] {
  const issuer = "industry/extract/W1N1/mineral/H";
  return {
    budgetBinding: { category: "industry", issuer },
    contractId: "industry-extraction",
    execution: {
      action: "harvest",
      completion: "target-depleted",
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    issuer,
    issuerSequence: 1,
    owner: { id: "W1N1", kind: "colony" },
    state: "active",
    targetId: "mineral",
  };
}

function snapshot(): WorldSnapshot {
  const room = {
    name: "W1N1",
    observedAt: 100,
    controller: { level: 6, ownership: "owned" },
    mineral: {
      amount: 10_000,
      density: 2,
      id: "mineral",
      mineralType: "H",
      pos: { roomName: "W1N1", x: 20, y: 21 },
      ticksToRegeneration: null,
    },
    ownedExtractors: [
      {
        active: true,
        cooldown: 0,
        hits: 500,
        hitsMax: 500,
        id: "extractor",
        pos: { roomName: "W1N1", x: 20, y: 21 },
      },
    ],
    ownedStorages: [
      {
        active: true,
        hits: 10_000,
        hitsMax: 10_000,
        id: "storage",
        pos: { roomName: "W1N1", x: 10, y: 10 },
        store: { capacity: 10_000, freeCapacity: 5_000, resources: [], usedCapacity: 5_000 },
      },
    ],
    ownedTerminals: [
      {
        active: true,
        cooldown: 0,
        hits: 3_000,
        hitsMax: 3_000,
        id: "terminal",
        pos: { roomName: "W1N1", x: 11, y: 10 },
        store: {
          capacity: 3_000,
          freeCapacity: 2_000,
          resources: [
            { amount: 500, resourceType: "energy" },
            { amount: 500, resourceType: "H" },
          ],
          usedCapacity: 1_000,
        },
      },
    ],
  };
  return { ownedRooms: [room] } as unknown as WorldSnapshot;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required test value is absent");
  return value;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
