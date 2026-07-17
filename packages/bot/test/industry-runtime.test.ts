import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../src/colony";
import type { ArbitrationBatch } from "../src/execution";
import {
  authorizeIndustryWork,
  eligibleIndustrySendIds,
  executeTerminalSendIntents,
  observeIndustryRooms,
  projectIndustryBudgets,
  projectIndustryTelemetry,
  projectTerminalSendIntents,
  reconcileIndustryCommands,
  type IndustryPlan,
  type TerminalSendIntent,
} from "../src/industry";
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
    const authorized = authorizeIndustryWork({
      plan,
      reservations: [reservation(required(budgets[0]))],
      rooms,
      tick: 100,
    });
    expect(authorized.extractionContracts).toHaveLength(1);
    expect(authorized.extractionContracts[0]).toMatchObject({
      budgetBinding: { category: "industry", issuer: "industry/extract/W1N1/mineral/H" },
      execution: { action: "harvest", resourceType: "H", version: 1 },
      target: { roomName: "W1N1", x: 20, y: 21 },
      targetId: "mineral",
    });
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
});

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
    grant: { energy: 800, cpu: 0.5, spawn: null },
    consumed: { energy: 0, cpu: 0, spawn: false },
    createdAt: 100,
    updatedAt: 100,
    status: "active",
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
