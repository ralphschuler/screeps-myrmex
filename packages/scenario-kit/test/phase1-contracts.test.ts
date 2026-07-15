import { describe, expect, it } from "vitest";
import {
  ContractLedger,
  contractIdFor,
  type CapabilityVector,
  type ContractFundingDecision,
  type ContractFundingView,
  type ContractLedgerStateV1,
  type ContractReconciliationResult,
  type ContractSubmissionResult,
  type ContractTransitionRequest,
  type ContractTransitionResult,
  type TravelEstimateView,
  type WorkforceActor,
  type WorkContractRecord,
  type WorkContractRequest,
} from "../../bot/src/contracts";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src/index";

const PRIMARY_ID = contractIdFor("scenario:planner", "primary-harvest", 1);
const EXPIRING_ID = contractIdFor("scenario:planner", "expiring-harvest", 2);
const BOUNDARY_ID = contractIdFor("scenario:planner", "boundary-completion", 3);

const THREE_TICK_TRAVEL: TravelEstimateView = Object.freeze({
  estimate: () => 3,
});

const POSITION_TRAVEL: TravelEstimateView = Object.freeze({
  estimate: (actor: WorkforceActor, contract: WorkContractRecord) =>
    actor.pos.roomName === contract.target.roomName
      ? Math.max(
          Math.abs(actor.pos.x - contract.target.x),
          Math.abs(actor.pos.y - contract.target.y),
        )
      : null,
});

interface ContractWorld {
  readonly contracts: ContractLedgerStateV1;
}

interface ContractInput {
  readonly actors: readonly WorkforceActor[];
  readonly funding: ContractFundingView;
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

interface ContractOutcome {
  readonly active: readonly {
    readonly actorId: string | null;
    readonly id: string;
    readonly state: string;
  }[];
  readonly assignments: ContractReconciliationResult["allocation"]["assignments"];
  readonly funding: readonly ContractFundingDecision[];
  readonly releases: ContractReconciliationResult["releases"];
  readonly submissions: readonly ContractSubmissionResult[];
  readonly terminal: readonly {
    readonly id: string;
    readonly state: string;
    readonly tick: number;
  }[];
  readonly transitions: readonly ContractTransitionResult[];
}

describe("Phase 1 contract replay scenarios", () => {
  it("replays idempotent leases and terminal outcomes across heap resets and reordered inputs", () => {
    const warm = runScenario(contractScenario({ resetAtDeath: false, reverseInputs: false }));
    const reset = runScenario(contractScenario({ resetAtDeath: true, reverseInputs: false }));
    const reordered = runScenario(contractScenario({ resetAtDeath: false, reverseInputs: true }));

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);
    expect(reset.transcript.ticks.map(({ heapReset }) => heapReset)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);

    expect(reordered.outcomes).toEqual(warm.outcomes);
    expect(reordered.finalWorld).toEqual(warm.finalWorld);
    expect(reordered.outcomeHash).toBe(warm.outcomeHash);
    expect(reordered.transcriptHash).not.toBe(warm.transcriptHash);

    const created = warm.outcomes[0];
    expect(created?.submissions).toEqual([
      { accepted: true, contractId: PRIMARY_ID, outcome: "created" },
      { accepted: true, contractId: EXPIRING_ID, outcome: "created" },
    ]);
    expect(actorFor(created, PRIMARY_ID)).toBe("actor:a");
    expect(actorFor(created, EXPIRING_ID)).toBeNull();

    const retried = warm.outcomes[1];
    expect(retried?.submissions).toEqual([
      { accepted: true, contractId: PRIMARY_ID, outcome: "duplicate-active" },
      { accepted: true, contractId: EXPIRING_ID, outcome: "duplicate-active" },
    ]);
    expect(retried?.releases).toEqual([
      { contractId: PRIMARY_ID, reason: "actor-ttl-insufficient" },
    ]);
    expect(actorFor(retried, PRIMARY_ID)).toBe("actor:z");

    const afterDeath = warm.outcomes[2];
    expect(afterDeath?.releases).toEqual([{ contractId: PRIMARY_ID, reason: "actor-missing" }]);
    expect(actorFor(afterDeath, PRIMARY_ID)).toBe("actor:b");

    expect(warm.outcomes[3]?.terminal).toEqual([{ id: PRIMARY_ID, state: "cancelled", tick: 103 }]);
    expect(warm.outcomes[4]?.submissions).toEqual([
      { accepted: true, contractId: PRIMARY_ID, outcome: "duplicate-terminal" },
    ]);
    expect(warm.outcomes[4]?.terminal).toHaveLength(1);
    expect(warm.outcomes[5]?.terminal).toEqual([{ id: PRIMARY_ID, state: "cancelled", tick: 103 }]);
    expect(warm.outcomes[6]?.terminal).toEqual([
      { id: PRIMARY_ID, state: "cancelled", tick: 103 },
      { id: EXPIRING_ID, state: "expired", tick: 106 },
    ]);

    expect(warm.finalWorld.contracts.active).toEqual([]);
    expect(warm.finalWorld.contracts.outcomes).toHaveLength(2);
    expect(
      warm.finalWorld.contracts.outcomes.filter(({ state }) => state === "cancelled"),
    ).toHaveLength(1);
    expect(
      warm.finalWorld.contracts.outcomes.filter(({ state }) => state === "expired"),
    ).toHaveLength(1);
    expect(Object.keys(warm.finalWorld)).toEqual(["contracts"]);
    expect(JSON.parse(JSON.stringify(warm.finalWorld))).toEqual(warm.finalWorld);
  });

  it("retains an exact-boundary lease across modeled progress until completion", () => {
    const warm = runScenario(boundaryCompletionScenario(false));
    const reset = runScenario(boundaryCompletionScenario(true));

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);

    for (const outcome of warm.outcomes.slice(0, -1)) {
      expect(actorFor(outcome, BOUNDARY_ID)).toBe("actor:boundary");
      expect(outcome.releases).toEqual([]);
      expect(outcome.assignments).toEqual([
        expect.objectContaining({ actorId: "actor:boundary", contractId: BOUNDARY_ID }),
      ]);
    }
    expect(warm.outcomes[8]?.terminal).toEqual([
      { id: BOUNDARY_ID, state: "completed", tick: 108 },
    ]);
    expect(warm.finalWorld.contracts.active).toEqual([]);
  });

  it("replays authorization loss and renewed funding across reset and input order", () => {
    const warm = runScenario(fundingLifecycleScenario(false, false));
    const reset = runScenario(fundingLifecycleScenario(true, false));
    const reordered = runScenario(fundingLifecycleScenario(false, true));

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reordered.outcomes).toEqual(warm.outcomes);
    expect(reordered.finalWorld).toEqual(warm.finalWorld);

    expect(warm.outcomes[2]?.releases).toEqual([
      { contractId: PRIMARY_ID, reason: "budget-authorization-lost" },
    ]);
    expect(warm.outcomes[2]?.active).toEqual([
      { actorId: null, id: PRIMARY_ID, state: "suspended" },
    ]);
    expect(warm.outcomes[3]?.transitions).toEqual([
      { accepted: true, contractId: PRIMARY_ID, from: "suspended", to: "funded" },
    ]);
    expect(actorFor(warm.outcomes[3], PRIMARY_ID)).toBe("actor:b");
  });
});

function fundingLifecycleScenario(
  resetOnRevocation: boolean,
  reverseInputs: boolean,
): ReplayScenario<ContractWorld, ContractInput, ContractOutcome> {
  const request = primaryRequest();
  const ticks = [
    {
      cpuBudget: 2,
      gameTime: 100,
      input: {
        actors: [exactBoundaryActor("actor:a")],
        funding: fundingAt(100, reverseInputs),
        requests: [request],
        transitions: [fund(PRIMARY_ID, 100)],
      },
      resetHeap: false,
    },
    {
      cpuBudget: 2,
      gameTime: 101,
      input: {
        actors: [exactBoundaryActor("actor:a")],
        funding: fundingAt(101, reverseInputs),
        requests: [],
        transitions: [
          { contractId: PRIMARY_ID, reason: "work-started", tick: 101, to: "active" as const },
        ],
      },
      resetHeap: false,
    },
    {
      cpuBudget: 2,
      gameTime: 102,
      input: {
        actors: [exactBoundaryActor("actor:b")],
        funding: fundingAt(102, reverseInputs, "released"),
        requests: [],
        transitions: [],
      },
      resetHeap: resetOnRevocation,
    },
    {
      cpuBudget: 2,
      gameTime: 103,
      input: {
        actors: [exactBoundaryActor("actor:b")],
        funding: fundingAt(103, reverseInputs),
        requests: [request],
        transitions: [fund(PRIMARY_ID, 103)],
      },
      resetHeap: false,
    },
  ];

  return defineReplayScenario<ContractWorld, ContractInput, ContractOutcome>({
    id: "phase1/contracts/funding-loss-renewal",
    seed: "phase1-contract-funding",
    initialWorld: {
      contracts: { active: [], issuerFrontiers: [], outcomes: [], schemaVersion: 1 },
    },
    ticks,
    step: ({ gameTime, input, world }) => {
      const opened = ContractLedger.open(world.contracts);
      if (opened.status !== "ready") {
        throw new Error(`expected ready ledger, got ${opened.status}`);
      }
      const reconciliation = opened.ledger.reconcile({
        actors: maybeReverse(input.actors, reverseInputs),
        funding: input.funding,
        requests: maybeReverse(input.requests, reverseInputs),
        tick: gameTime,
        transitions: maybeReverse(input.transitions, reverseInputs),
        travel: THREE_TICK_TRAVEL,
      });
      const contracts = opened.ledger.view();
      return {
        cpuUsed: 1,
        nextWorld: { contracts },
        outcome: summarize(contracts, reconciliation),
      };
    },
  });
}

function boundaryCompletionScenario(
  resetMidLease: boolean,
): ReplayScenario<ContractWorld, ContractInput, ContractOutcome> {
  const request = makeRequest({
    deadline: 108,
    estimatedWorkTicks: 5,
    expiresAt: 109,
    issuerKey: "boundary-completion",
    leasePolicy: { duration: 20, switchingPenalty: 2, ttlSafetyMargin: 2 },
    priority: { class: "survival", value: 100 },
    requiredCapability: capability({ work: 1 }),
  });
  const ticks = Array.from({ length: 9 }, (_, offset) => {
    const gameTime = 100 + offset;
    const transitions: ContractTransitionRequest[] =
      offset === 0
        ? [fund(BOUNDARY_ID, gameTime)]
        : offset === 1
          ? [{ contractId: BOUNDARY_ID, reason: "work-started", tick: gameTime, to: "active" }]
          : offset === 8
            ? [
                {
                  contractId: BOUNDARY_ID,
                  reason: "objective-complete",
                  tick: gameTime,
                  to: "completed",
                },
              ]
            : [];
    return {
      cpuBudget: 2,
      gameTime,
      input: {
        actors: [progressingBoundaryActor(offset)],
        funding: fundingAt(gameTime, false),
        requests: offset === 0 ? [request] : [],
        transitions,
      },
      resetHeap: resetMidLease && offset === 4,
    };
  });

  return defineReplayScenario<ContractWorld, ContractInput, ContractOutcome>({
    id: "phase1/contracts/exact-boundary-completion",
    seed: "phase1-contracts-boundary",
    initialWorld: {
      contracts: { active: [], issuerFrontiers: [], outcomes: [], schemaVersion: 1 },
    },
    ticks,
    step: ({ gameTime, input, world }) => {
      const opened = ContractLedger.open(world.contracts);
      if (opened.status !== "ready") {
        throw new Error(`expected ready ledger, got ${opened.status}`);
      }
      const reconciliation = opened.ledger.reconcile({
        actors: input.actors,
        funding: input.funding,
        requests: input.requests,
        tick: gameTime,
        transitions: input.transitions,
        travel: POSITION_TRAVEL,
      });
      const contracts = opened.ledger.view();
      return {
        cpuUsed: 1,
        nextWorld: { contracts },
        outcome: summarize(contracts, reconciliation),
      };
    },
  });
}

function contractScenario(options: {
  readonly resetAtDeath: boolean;
  readonly reverseInputs: boolean;
}): ReplayScenario<ContractWorld, ContractInput, ContractOutcome> {
  const primary = primaryRequest();
  const expiring = expiringRequest();
  const ticks = [
    tickInput(
      100,
      [exactBoundaryActor("actor:a"), exactBoundaryActor("actor:z")],
      [primary, expiring],
      [fund(PRIMARY_ID, 100), fund(EXPIRING_ID, 100)],
      options,
    ),
    tickInput(
      101,
      [belowBoundaryActor("actor:a"), exactBoundaryActor("actor:z")],
      [primary, expiring],
      [{ contractId: PRIMARY_ID, reason: "work-started", tick: 101, to: "active" }],
      options,
    ),
    tickInput(102, [exactBoundaryActor("actor:b")], [], [], options, options.resetAtDeath),
    tickInput(
      103,
      [],
      [],
      [{ contractId: PRIMARY_ID, reason: "objective-cancelled", tick: 103, to: "cancelled" }],
      options,
    ),
    tickInput(104, [], [primary], [], options),
    tickInput(105, [], [expiring], [], options),
    tickInput(106, [], [], [], options),
  ];

  return defineReplayScenario<ContractWorld, ContractInput, ContractOutcome>({
    id: "phase1/contracts/idempotent-lease-lifecycle",
    seed: "phase1-contracts",
    initialWorld: {
      contracts: { active: [], issuerFrontiers: [], outcomes: [], schemaVersion: 1 },
    },
    ticks,
    step: ({ gameTime, input, world }) => {
      const opened = ContractLedger.open(world.contracts);
      if (opened.status !== "ready") {
        throw new Error(`expected ready ledger, got ${opened.status}`);
      }
      const reconciliation = opened.ledger.reconcile({
        actors: input.actors,
        funding: input.funding,
        requests: input.requests,
        tick: gameTime,
        transitions: input.transitions,
        travel: THREE_TICK_TRAVEL,
      });
      const contracts = opened.ledger.view();

      return {
        cpuUsed: 1,
        nextWorld: { contracts },
        outcome: summarize(contracts, reconciliation),
      };
    },
  });
}

function tickInput(
  gameTime: number,
  actors: readonly WorkforceActor[],
  requests: readonly WorkContractRequest[],
  transitions: readonly ContractTransitionRequest[],
  options: { readonly reverseInputs: boolean },
  resetHeap = false,
): {
  readonly cpuBudget: number;
  readonly gameTime: number;
  readonly input: ContractInput;
  readonly resetHeap: boolean;
} {
  return {
    cpuBudget: 2,
    gameTime,
    input: {
      actors: maybeReverse(actors, options.reverseInputs),
      funding: fundingAt(gameTime, options.reverseInputs),
      requests: maybeReverse(requests, options.reverseInputs),
      transitions: maybeReverse(transitions, options.reverseInputs),
    },
    resetHeap,
  };
}

function summarize(
  contracts: ContractLedgerStateV1,
  reconciliation: ContractReconciliationResult,
): ContractOutcome {
  return {
    active: contracts.active.map(({ id, lease, state }) => ({
      actorId: lease?.actorId ?? null,
      id,
      state,
    })),
    assignments: reconciliation.allocation.assignments,
    funding: reconciliation.funding,
    releases: reconciliation.releases,
    submissions: [...reconciliation.submissions].sort(compareContractResults),
    terminal: contracts.outcomes.map(({ id, state, tick }) => ({ id, state, tick })),
    transitions: [...reconciliation.transitions].sort(compareContractResults),
  };
}

function actorFor(outcome: ContractOutcome | undefined, contractId: string): string | null {
  return outcome?.active.find(({ id }) => id === contractId)?.actorId ?? null;
}

function compareContractResults(
  left: { readonly contractId: string | null },
  right: { readonly contractId: string | null },
): number {
  const leftId = left.contractId ?? "";
  const rightId = right.contractId ?? "";
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function maybeReverse<T>(values: readonly T[], reverse: boolean): readonly T[] {
  return reverse ? [...values].reverse() : values;
}

function fundingAt(
  tick: number,
  reverse: boolean,
  status: "active" | "released" = "active",
): ContractFundingView {
  const revision = tick - 99;
  const authorizations = [
    {
      category: "harvesting-filling",
      colonyId: "W1N1",
      expiresAt: tick + 1,
      issuer: "scenario:budget",
      reservationId: `reservation:scenario:${String(revision)}`,
      revision,
      status,
    },
    {
      category: "optional-growth",
      colonyId: "W9N9",
      expiresAt: tick + 1,
      issuer: "scenario:unrelated",
      reservationId: `reservation:unrelated:${String(revision)}`,
      revision,
      status: "active" as const,
    },
  ];
  return {
    authorizations: maybeReverse(authorizations, reverse),
    owners: maybeReverse(
      [
        { id: "W1N1", visibility: "visible" as const },
        { id: "W9N9", visibility: "visible" as const },
      ],
      reverse,
    ),
    status: "ready",
  };
}

function fund(contractId: string, tick: number): ContractTransitionRequest {
  return { contractId, reason: "budget-funded", tick, to: "funded" };
}

function primaryRequest(): WorkContractRequest {
  return makeRequest({
    deadline: 200,
    estimatedWorkTicks: 5,
    expiresAt: 201,
    issuerKey: "primary-harvest",
    leasePolicy: { duration: 20, switchingPenalty: 2, ttlSafetyMargin: 2 },
    priority: { class: "survival", value: 100 },
    requiredCapability: capability({ work: 1 }),
  });
}

function expiringRequest(): WorkContractRequest {
  return makeRequest({
    deadline: 105,
    estimatedWorkTicks: 1,
    expiresAt: 106,
    issuerKey: "expiring-harvest",
    leasePolicy: { duration: 20, switchingPenalty: 2, ttlSafetyMargin: 0 },
    priority: { class: "growth", value: 1 },
    requiredCapability: capability({ claim: 1 }),
  });
}

function makeRequest(
  overrides: Pick<
    WorkContractRequest,
    | "deadline"
    | "estimatedWorkTicks"
    | "expiresAt"
    | "issuerKey"
    | "leasePolicy"
    | "priority"
    | "requiredCapability"
  >,
): WorkContractRequest {
  return {
    budgetBinding: {
      category: "harvesting-filling",
      issuer:
        overrides.issuerKey === "expiring-harvest" ? "scenario:budget:expiring" : "scenario:budget",
    },
    conditions: {
      cancellation: "objective-cancelled",
      failure: "objective-failed",
      success: "objective-complete",
    },
    earliestStart: 100,
    issuer: "scenario:planner",
    issuerSequence:
      overrides.issuerKey === "primary-harvest"
        ? 1
        : overrides.issuerKey === "expiring-harvest"
          ? 2
          : 3,
    kind: "harvest",
    maxAssignmentCost: 20,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: ["source-visible"],
    quantity: 1,
    range: 1,
    target: { roomName: "W1N1", x: 10, y: 10 },
    targetId: "source:1",
    ...overrides,
  };
}

function exactBoundaryActor(id: string): WorkforceActor {
  return makeActor(id, 11);
}

function belowBoundaryActor(id: string): WorkforceActor {
  return makeActor(id, 9);
}

function makeActor(id: string, ticksToLive: number): WorkforceActor {
  return {
    capability: capability({ move: 1, work: 1 }),
    id,
    name: id,
    pos: { roomName: "W1N1", x: 7, y: 10 },
    spawning: false,
    ticksToLive,
  };
}

function progressingBoundaryActor(offset: number): WorkforceActor {
  return {
    ...makeActor("actor:boundary", 11 - offset),
    // The lease is first created after tick-100 Execute, so its first movement can only appear in
    // the tick-102 Observe snapshot after being issued during tick-101 Execute.
    pos: { roomName: "W1N1", x: Math.min(10, 7 + Math.max(0, offset - 1)), y: 10 },
  };
}

function capability(overrides: Partial<CapabilityVector> = {}): CapabilityVector {
  return {
    attack: 0,
    carry: 0,
    claim: 0,
    heal: 0,
    move: 0,
    rangedAttack: 0,
    tough: 0,
    work: 0,
    ...overrides,
  };
}
