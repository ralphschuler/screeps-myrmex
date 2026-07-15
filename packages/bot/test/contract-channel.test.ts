import { describe, expect, it } from "vitest";
import {
  MAX_CONTRACT_REQUESTS_PER_TICK,
  MAX_CONTRACT_TRANSITIONS_PER_TICK,
  createContractRequestChannel,
  type CapabilityVector,
  type ContractRequestBatch,
  type ContractTransitionRequest,
  type WorkContractRequest,
} from "../src/contracts";

describe("contract request channel", () => {
  it("publishes committed producer data atomically and omits discarded stages", () => {
    const channel = createContractRequestChannel();
    const committed = channel.openProducer("planner.committed");
    committed.producer.submit(makeRequest("contract-a"));
    committed.producer.submit(makeRequest("contract-b"));
    committed.producer.transition(makeTransition("contract:a", { tick: 101 }));
    const committedStage = committed.stage();

    const discarded = channel.openProducer("planner.discarded");
    discarded.producer.submit(makeRequest("contract-c"));
    discarded.producer.transition(makeTransition("contract:c"));
    const discardedStage = discarded.stage();

    expect(committedStage).toMatchObject({ requests: 2, transitions: 1 });
    expect(discardedStage).toMatchObject({ requests: 1, transitions: 1 });
    expect(Object.isFrozen(committedStage)).toBe(true);

    committedStage.commit();
    discardedStage.discard();
    const batch = channel.seal();

    expect(batch.requests.map(({ issuerKey }) => issuerKey)).toEqual(["contract-a", "contract-b"]);
    expect(batch.transitions).toEqual([makeTransition("contract:a", { tick: 101 })]);
    expect(() => {
      committedStage.commit();
    }).toThrow(/already resolved/u);
    expect(() => {
      discardedStage.commit();
    }).toThrow(/already resolved/u);
  });

  it("fail-closes open and unresolved staged producers when sealed", () => {
    const channel = createContractRequestChannel();
    commit(channel, "planner.healthy", [makeRequest("contract-a")]);

    const open = channel.openProducer("planner.open");
    open.producer.submit(makeRequest("contract-b"));
    open.producer.transition(makeTransition("contract:b"));

    const unresolved = channel.openProducer("planner.staged");
    unresolved.producer.submit(makeRequest("contract-c"));
    unresolved.producer.transition(makeTransition("contract:c"));
    const staged = unresolved.stage();

    const batch = channel.seal();

    expect(batch.requests.map(({ issuerKey }) => issuerKey)).toEqual(["contract-a"]);
    expect(batch.transitions).toEqual([]);
    expect(() => {
      open.producer.submit(makeRequest("contract-d"));
    }).toThrow(/closed/u);
    expect(() => open.stage()).toThrow(/closed/u);
    expect(() => {
      unresolved.producer.transition(makeTransition("contract:d"));
    }).toThrow(/closed/u);
    expect(() => {
      staged.commit();
    }).toThrow(/closed/u);
  });

  it("canonicalizes requests and transitions independently of producer and input order", () => {
    const forward = collectCanonicalBatch(false);
    const reversed = collectCanonicalBatch(true);

    expect(reversed).toEqual(forward);
    expect(forward.requests.map(({ issuerKey }) => issuerKey)).toEqual([
      "contract-a",
      "contract-b",
      "contract-c",
    ]);
    expect(
      forward.transitions.map(({ contractId, reason, tick, to }) => [tick, contractId, to, reason]),
    ).toEqual([
      [99, "contract:c", "active", "activate"],
      [100, "contract:a", "active", "activate"],
      [100, "contract:a", "funded", "fund"],
      [100, "contract:b", "funded", "fund"],
    ]);
  });

  it("rejects only the producer that exceeds aggregate request capacity", () => {
    const channel = createContractRequestChannel();
    commit(
      channel,
      "planner.first",
      Array.from({ length: 65 }, (_, index) => makeRequest(`first-${String(index)}`)),
    );
    const overflow = channel.openProducer("planner.second");
    for (let index = 0; index < 64; index += 1) {
      overflow.producer.submit(makeRequest(`second-${String(index)}`));
    }
    const staged = overflow.stage();

    expect(() => {
      staged.commit();
    }).toThrow(`committed request capacity of ${String(MAX_CONTRACT_REQUESTS_PER_TICK)} exceeded`);
    const batch = channel.seal();
    expect(batch.requests).toHaveLength(65);
    expect(batch.requests.every(({ issuerKey }) => issuerKey.startsWith("first-"))).toBe(true);
    expect(() => channel.openProducer("planner.after-overload")).toThrow(/already sealed/u);
    expect(() => channel.seal()).toThrow(/already sealed/u);
  });

  it("rejects an aggregate transition overflow atomically with its requests", () => {
    const channel = createContractRequestChannel();
    commit(
      channel,
      "planner.first",
      [],
      Array.from({ length: 65 }, (_, index) => makeTransition(`contract:first-${String(index)}`)),
    );
    const overflow = channel.openProducer("planner.second");
    overflow.producer.submit(makeRequest("overflow-must-not-leak"));
    for (let index = 0; index < 64; index += 1) {
      overflow.producer.transition(makeTransition(`contract:second-${String(index)}`));
    }
    const staged = overflow.stage();

    expect(() => {
      staged.commit();
    }).toThrow(
      `committed transition capacity of ${String(MAX_CONTRACT_TRANSITIONS_PER_TICK)} exceeded`,
    );
    const batch = channel.seal();
    expect(batch.requests).toEqual([]);
    expect(batch.transitions).toHaveLength(65);
    expect(
      batch.transitions.every(({ contractId }) => contractId.startsWith("contract:first-")),
    ).toBe(true);
    expect(() => channel.openProducer("planner.after-overload")).toThrow(/already sealed/u);
    expect(() => channel.seal()).toThrow(/already sealed/u);
  });

  it("enforces independent per-producer request and transition caps", () => {
    const channel = createContractRequestChannel();
    const scope = channel.openProducer("planner.at-capacity");

    for (let index = 0; index < MAX_CONTRACT_REQUESTS_PER_TICK; index += 1) {
      scope.producer.submit(makeRequest(`request-${String(index)}`));
    }
    for (let index = 0; index < MAX_CONTRACT_TRANSITIONS_PER_TICK; index += 1) {
      scope.producer.transition(makeTransition(`contract:${String(index)}`));
    }

    expect(() => {
      scope.producer.submit(makeRequest("request-overflow"));
    }).toThrow(`exceeded ${String(MAX_CONTRACT_REQUESTS_PER_TICK)} requests`);
    expect(() => {
      scope.producer.transition(makeTransition("contract:overflow"));
    }).toThrow(`exceeded ${String(MAX_CONTRACT_TRANSITIONS_PER_TICK)} transitions`);

    const staged = scope.stage();
    expect(staged).toMatchObject({
      requests: MAX_CONTRACT_REQUESTS_PER_TICK,
      transitions: MAX_CONTRACT_TRANSITIONS_PER_TICK,
    });
    staged.commit();

    const batch = channel.seal();
    expect(batch.requests).toHaveLength(MAX_CONTRACT_REQUESTS_PER_TICK);
    expect(batch.transitions).toHaveLength(MAX_CONTRACT_TRANSITIONS_PER_TICK);
  });

  it("closes producer mutation at staging and every channel boundary exactly once", () => {
    const channel = createContractRequestChannel();
    const scope = channel.openProducer("planner.lifecycle");
    scope.producer.submit(makeRequest("contract-a"));
    const staged = scope.stage();

    expect(() => {
      scope.producer.submit(makeRequest("contract-b"));
    }).toThrow(/closed|staged/u);
    expect(() => scope.stage()).toThrow(/closed|staged/u);
    staged.commit();
    expect(() => {
      staged.commit();
    }).toThrow(/already resolved/u);

    const discarded = channel.openProducer("planner.discarded");
    discarded.producer.submit(makeRequest("contract-c"));
    discarded.discard();
    expect(() => discarded.stage()).toThrow(/closed/u);
    expect(() => {
      discarded.producer.transition(makeTransition("contract:c"));
    }).toThrow(/closed/u);
    expect(() => channel.openProducer("planner.lifecycle")).toThrow(/already open/u);

    expect(channel.seal().requests.map(({ issuerKey }) => issuerKey)).toEqual(["contract-a"]);
    expect(() => channel.openProducer("planner.after-seal")).toThrow(/already sealed/u);
    expect(() => channel.seal()).toThrow(/already sealed/u);
  });

  it("returns a detached, recursively immutable, data-only batch", () => {
    const target = { roomName: "W1N1", x: 20, y: 20 };
    const requiredCapability = {
      attack: 0,
      carry: 0,
      claim: 0,
      heal: 0,
      move: 0,
      rangedAttack: 0,
      tough: 0,
      work: 1,
    };
    const preconditionKeys = ["source-open", "room-visible"];
    const request = makeRequest("contract-a", {
      preconditionKeys,
      requiredCapability,
      target,
    });
    const transition = makeTransition("contract:a");
    const channel = createContractRequestChannel();
    const scope = channel.openProducer("planner.immutable");

    scope.producer.submit(request);
    scope.producer.transition(transition);
    target.x = 49;
    requiredCapability.work = 0;
    preconditionKeys.push("mutated-after-submit");
    const staged = scope.stage();
    staged.commit();
    const batch = channel.seal();

    expect(batch.requests[0]).toMatchObject({
      preconditionKeys: ["room-visible", "source-open"],
      requiredCapability: { work: 1 },
      target: { roomName: "W1N1", x: 20, y: 20 },
    });
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.requests)).toBe(true);
    expect(Object.isFrozen(batch.transitions)).toBe(true);
    expect(Object.isFrozen(batch.requests[0])).toBe(true);
    expect(Object.isFrozen(batch.requests[0]?.target)).toBe(true);
    expect(Object.isFrozen(batch.requests[0]?.requiredCapability)).toBe(true);
    expect(Object.isFrozen(batch.requests[0]?.preconditionKeys)).toBe(true);
    expect(Object.isFrozen(batch.transitions[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(batch))).toEqual(batch);
    expect(() =>
      (batch.requests as unknown as WorkContractRequest[]).push(makeRequest("contract-b")),
    ).toThrow(TypeError);
  });

  it("rejects invalid requests and transitions without appending partial entries", () => {
    const channel = createContractRequestChannel();
    const scope = channel.openProducer("planner.validation");

    expect(() => {
      scope.producer.submit(
        makeRequest("invalid-capability", { requiredCapability: capability() }),
      );
    }).toThrow(/must require at least one active part/u);
    expect(() => {
      scope.producer.submit(makeRequest("invalid-expiry", { deadline: 120, expiresAt: 120 }));
    }).toThrow(/must be after the inclusive deadline/u);
    expect(() => {
      scope.producer.transition(makeTransition("contract:a", { tick: -1 }));
    }).toThrow(/non-negative safe integer/u);
    expect(() => {
      scope.producer.transition(makeTransition(" untrimmed-contract-id"));
    }).toThrow(/bounded, trimmed contractId/u);
    expect(() => {
      scope.producer.transition(makeTransition("contract:a", { reason: " untrimmed" }));
    }).toThrow(/bounded, trimmed string/u);
    expect(() => {
      scope.producer.transition(
        makeTransition("contract:a", {
          to: "not-a-contract-state" as ContractTransitionRequest["to"],
        }),
      );
    }).toThrow(/state|transition/u);

    scope.producer.submit(makeRequest("contract-valid"));
    scope.producer.transition(makeTransition("contract:valid"));
    const staged = scope.stage();

    expect(staged).toMatchObject({ requests: 1, transitions: 1 });
    staged.commit();
    expect(channel.seal()).toMatchObject({
      requests: [{ issuerKey: "contract-valid" }],
      transitions: [{ contractId: "contract:valid" }],
    });
  });
});

function collectCanonicalBatch(reverse: boolean): ContractRequestBatch {
  const channel = createContractRequestChannel();
  const producerInputs = [
    {
      requests: [makeRequest("contract-c"), makeRequest("contract-a")],
      systemId: "planner.zeta",
      transitions: [
        makeTransition("contract:b"),
        makeTransition("contract:a", { reason: "activate", to: "active" }),
      ],
    },
    {
      requests: [makeRequest("contract-b")],
      systemId: "planner.alpha",
      transitions: [
        makeTransition("contract:a"),
        makeTransition("contract:c", { reason: "activate", tick: 99, to: "active" }),
      ],
    },
  ];

  for (const input of reverse ? producerInputs.reverse() : producerInputs) {
    commit(
      channel,
      input.systemId,
      reverse ? input.requests.reverse() : input.requests,
      reverse ? input.transitions.reverse() : input.transitions,
    );
  }
  return channel.seal();
}

function commit(
  channel: ReturnType<typeof createContractRequestChannel>,
  systemId: string,
  requests: readonly WorkContractRequest[],
  transitions: readonly ContractTransitionRequest[] = [],
): void {
  const scope = channel.openProducer(systemId);
  for (const request of requests) {
    scope.producer.submit(request);
  }
  for (const transition of transitions) {
    scope.producer.transition(transition);
  }
  scope.stage().commit();
}

function makeRequest(
  issuerKey: string,
  overrides: Partial<WorkContractRequest> = {},
): WorkContractRequest {
  return {
    budgetBinding: { category: "harvesting-filling", issuer: "test:budget" },
    conditions: { cancellation: null, failure: null, success: "work-complete" },
    deadline: 120,
    earliestStart: 100,
    estimatedWorkTicks: 5,
    expiresAt: 121,
    issuer: "planner.channel",
    issuerKey,
    issuerSequence: 1,
    kind: "harvest",
    leasePolicy: { duration: 10, switchingPenalty: 2, ttlSafetyMargin: 3 },
    maxAssignmentCost: 20,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: ["room-visible"],
    priority: { class: "survival", value: 100 },
    quantity: 1,
    range: 1,
    requiredCapability: capability({ work: 1 }),
    target: { roomName: "W1N1", x: 20, y: 20 },
    targetId: "source:1",
    ...overrides,
  };
}

function makeTransition(
  contractId: string,
  overrides: Partial<ContractTransitionRequest> = {},
): ContractTransitionRequest {
  return {
    contractId,
    reason: "fund",
    tick: 100,
    to: "funded",
    ...overrides,
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
