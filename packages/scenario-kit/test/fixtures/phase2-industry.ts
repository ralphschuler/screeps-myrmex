import type { LedgerEntry } from "../../../bot/src/colony";
import {
  IndustryDirector,
  emptyIndustryOwner,
  parseIndustryOwner,
  persistIndustryCommands,
  projectIndustryBudgets,
  projectIndustryTelemetry,
  reconcileIndustryCommands,
  type IndustryPlan,
  type IndustryRoomState,
  type InternalSendRequest,
} from "../../../bot/src/industry";
import { canonicalSerialize } from "../../src";

const TICK = 1_000;
const REQUEST: InternalSendRequest = Object.freeze({
  amount: 200,
  deadline: TICK + 10,
  destinationRoom: "W2N2",
  id: "balance/H/1",
  resourceType: "H",
  sourceRoom: "W1N1",
});
const LIMITS = Object.freeze({
  maxExtractionProposals: 2,
  maxRoomsScanned: 2,
  maxSendProposals: 1,
  maxSendRequestsScanned: 2,
});

export function collectIndustryEvidence() {
  const warm = variant(false, false);
  const reset = variant(true, false);
  const reordered = variant(true, true);
  const expensive = plan(rooms(true), [REQUEST], () => 250);
  const unfunded = plan(rooms(false), [], () => 20);
  const vanished = plan(rooms(true).slice(0, 1), [REQUEST], () => 20);
  const failed = [
    {
      command: {
        amount: reset.plan.sends[0]?.amount ?? 0,
        destinationRoom: "W2N2",
        resourceType: "H",
        terminalId: "terminal/W1N1",
      },
      intentId: reset.plan.sends[0]?.identity ?? "missing",
      tick: TICK,
      reason: "ERR_INVALID_TARGET" as const,
      returnCode: -7,
      cpuUsed: 0,
      outcome: {
        state: "game-rejected" as const,
        code: -7 as const,
        name: "ERR_INVALID_TARGET" as const,
      },
      status: "rejected" as const,
    },
  ];
  const backoff = reconcileIndustryCommands({
    plan: reset.plan,
    previous: [],
    results: failed,
    tick: TICK,
  });
  const retired = reconcileIndustryCommands({
    plan: vanished,
    previous: backoff,
    results: [],
    tick: TICK + 1,
  });
  const durable = persistIndustryCommands(emptyIndustryOwner(), "industry-policy-v1", retired);
  const cold = parseIndustryOwner(JSON.parse(JSON.stringify(durable)));
  const telemetry = projectIndustryTelemetry({
    plan: reset.plan,
    results: failed,
    states: retired,
  });

  return Object.freeze({
    schemaVersion: 1,
    issue: 50,
    status: "complete",
    deterministicScenario: {
      ownedRcl6Rooms: 2,
      equivalentAfterWarmResetAndReorder:
        canonicalSerialize(warm.semantic) === canonicalSerialize(reset.semantic) &&
        canonicalSerialize(reset.semantic) === canonicalSerialize(reordered.semantic),
      extraction: {
        fundedAmount: reset.plan.extraction[0]?.amount ?? 0,
        fundedContracts: reset.semantic.fundedExtraction,
        unfundedProposals: unfunded.extraction.length,
      },
      terminal: {
        affordableSends: reset.plan.sends.length,
        expensiveSends: expensive.sends.length,
        expensiveReason:
          expensive.deferrals.find(({ reason }) => reason === "insufficient-energy")?.reason ??
          null,
        identity: reset.plan.sends[0]?.identity ?? null,
      },
      noGhostReservation:
        vanished.sends.length === 0 && retired.every(({ status }) => status === "retired"),
    },
    recovery: {
      attempt: backoff[0]?.attempt ?? 0,
      nextEligibleTick: backoff[0]?.nextEligibleTick ?? 0,
      resetEquivalent: canonicalSerialize(cold) === canonicalSerialize(durable),
      statusAfterDestinationLoss: retired[0]?.status ?? null,
    },
    accounting: telemetry.accounting,
    telemetry: {
      commands: telemetry.commands,
      deferred: telemetry.deferred,
      stateCount: telemetry.states.length,
    },
    boundaries: {
      commandExecutors: ["terminal.send"],
      maximumExtractionProposals: LIMITS.maxExtractionProposals,
      maximumSendProposals: LIMITS.maxSendProposals,
      maximumRoomsScanned: LIMITS.maxRoomsScanned,
      nonGoals: ["market orders", "remote minerals", "labs", "factories"],
    },
  });
}

function variant(reset: boolean, reorder: boolean) {
  let inputRooms = rooms(true);
  let requests: readonly InternalSendRequest[] = [REQUEST];
  if (reorder) {
    inputRooms = [...inputRooms].reverse();
    requests = [...requests].reverse();
  }
  if (reset) {
    inputRooms = roundTrip(inputRooms);
    requests = roundTrip(requests);
  }
  const industryPlan = plan(inputRooms, requests, () => 20);
  const budgets = projectIndustryBudgets(industryPlan, TICK);
  const reservations = budgets.map(reservation);
  return {
    plan: industryPlan,
    semantic: {
      extractionIds: industryPlan.extraction.map(({ identity }) => identity),
      fundedExtraction: industryPlan.extraction.filter(({ identity }) =>
        reservations.some(({ issuer, status }) => issuer === identity && status === "active"),
      ).length,
      sendIds: industryPlan.sends.map(({ identity }) => identity),
    },
  };
}

function plan(
  roomStates: readonly IndustryRoomState[],
  requests: readonly InternalSendRequest[],
  transactionCost: (amount: number, source: string, destination: string) => number,
): IndustryPlan {
  return new IndustryDirector().plan({
    limits: LIMITS,
    requests,
    rooms: roomStates,
    tick: TICK,
    transactionCost,
  });
}

function rooms(funded: boolean): IndustryRoomState[] {
  return [
    room("W1N1", 800, 500, []),
    room("W2N2", 100, 300, [
      { amount: 300, fundedAmount: funded ? 300 : 0, id: "labs/H", resourceType: "H" },
    ]),
  ];
}

function room(
  roomName: string,
  mineralStock: number,
  terminalEnergy: number,
  commitments: IndustryRoomState["commitments"],
): IndustryRoomState {
  return {
    bands: [{ resourceType: "H", min: 100, target: 500, max: 800 }],
    commitments,
    controllerLevel: 6,
    extractor: { active: true, cooldown: 0 },
    mineral: {
      amount: 10_000,
      id: `mineral/${roomName}`,
      pos: { roomName, x: 20, y: 20 },
      resourceType: "H",
      ticksToRegeneration: null,
    },
    protectedEnergy: 300,
    roomName,
    storage: { active: true, freeCapacity: 10_000, stocks: [] },
    terminal: {
      active: true,
      cooldown: 0,
      freeCapacity: 10_000,
      stocks: [
        { amount: mineralStock, resourceType: "H" },
        { amount: terminalEnergy, resourceType: "energy" },
      ],
    },
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
    grant: {
      energy: request.energy?.desired ?? 0,
      cpu: request.cpu?.desired ?? 0,
      spawn: null,
    },
    consumed: { energy: 0, cpu: 0, spawn: false },
    createdAt: TICK,
    updatedAt: TICK,
    status: "active",
  };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
