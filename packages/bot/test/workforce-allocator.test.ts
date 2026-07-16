import { describe, expect, it } from "vitest";
import {
  MAX_ALLOCATION_ACTORS,
  MAX_ALLOCATION_CONTRACTS,
  MAX_ALLOCATION_PAIRS,
  MAX_SAFE_IDLE_ACTORS,
  WorkforceAllocator,
  remainingModeledTicks,
  type CapabilityVector,
  type TravelEstimateView,
  type WorkforceActor,
  type WorkforceAllocationResult,
  type WorkContractRecord,
} from "../src/contracts";

const TICK = 100;

describe("WorkforceAllocator", () => {
  it("assigns harvest and transfer only to actors with the matching current cargo state", () => {
    const empty = makeActor("actor:empty", {
      capability: capability({ carry: 1, move: 1, work: 1 }),
      energy: 0,
      freeCapacity: 50,
    });
    const carrying = makeActor("actor:carrying", {
      capability: capability({ carry: 1, move: 1, work: 1 }),
      energy: 25,
      freeCapacity: 25,
    });
    const harvest = makeContract("contract:harvest", {
      execution: {
        action: "harvest",
        completion: "continuous",
        counterpartId: null,
        resourceType: null,
        version: 1,
      },
    });
    const transfer = makeContract("contract:transfer", {
      execution: {
        action: "transfer",
        completion: "continuous",
        counterpartId: null,
        resourceType: "energy",
        version: 1,
      },
      kind: "fill",
      requiredCapability: capability({ carry: 1 }),
    });

    expect(allocate([empty, carrying], [harvest, transfer]).assignments).toEqual([
      expect.objectContaining({ actorId: empty.id, contractId: harvest.id }),
      expect.objectContaining({ actorId: carrying.id, contractId: transfer.id }),
    ]);
  });

  it("preempts lower-priority work deterministically without assigning an actor twice", () => {
    const urgent = makeContract("contract:urgent", {
      kind: "defend",
      priority: { class: "safety", value: 1 },
      requiredCapability: capability({ attack: 1 }),
    });
    const optional = makeContract("contract:optional", {
      kind: "upgrade",
      priority: { class: "growth", value: 1_000 },
    });
    const onlyActor = makeActor("actor:only", {
      capability: capability({ attack: 1, work: 1 }),
    });

    const forward = allocate([onlyActor], [optional, urgent]);
    const reordered = allocate([onlyActor], [urgent, optional]);

    expect(reordered).toEqual(forward);
    expect(forward.assignments).toEqual([
      expect.objectContaining({ actorId: onlyActor.id, contractId: urgent.id }),
    ]);
    expect(forward.deferred).toContainEqual({
      contractId: optional.id,
      reason: "no-viable-actor",
    });
    expect(new Set(forward.assignments.map(({ actorId }) => actorId)).size).toBe(
      forward.assignments.length,
    );
    expect(new Set(forward.assignments.map(({ contractId }) => contractId)).size).toBe(
      forward.assignments.length,
    );
  });

  it("rejects damaged and insufficient capability in favor of a viable actor", () => {
    const contract = makeContract("contract:work-two", {
      requiredCapability: capability({ work: 2 }),
    });
    const damaged = makeActor("actor:damaged", { capability: capability() });
    const insufficient = makeActor("actor:insufficient", {
      capability: capability({ work: 1 }),
    });
    const viable = makeActor("actor:viable", { capability: capability({ work: 2 }) });

    const result = allocate([insufficient, viable, damaged], [contract]);

    expect(result.assignments).toEqual([
      expect.objectContaining({ actorId: viable.id, contractId: contract.id }),
    ]);
    expect(result.safeIdle).toEqual([
      { actorId: damaged.id, reason: "no-funded-contract" },
      { actorId: insufficient.id, reason: "no-funded-contract" },
    ]);
  });

  it("enforces spawning, TTL, and inclusive deadline feasibility at exact boundaries", () => {
    const contract = makeContract("contract:ttl-boundary", {
      deadline: 108,
      estimatedWorkTicks: 5,
      leasePolicy: { duration: 10, switchingPenalty: 4, ttlSafetyMargin: 2 },
    });
    const spawning = makeActor("actor:spawning", { spawning: true, ticksToLive: 100 });
    const unknownTtl = makeActor("actor:unknown-ttl", { ticksToLive: null });
    const shortLived = makeActor("actor:short-lived", { ticksToLive: 10 });
    const exactBoundary = makeActor("actor:exact-boundary", { ticksToLive: 11 });
    const travel = travelView(() => 3);

    const result = allocate([spawning, unknownTtl, shortLived, exactBoundary], [contract], travel);

    expect(result.assignments).toEqual([
      expect.objectContaining({
        actorId: exactBoundary.id,
        assignmentCost: 3,
        contractId: contract.id,
        travelTicks: 3,
      }),
    ]);
    expect(result.safeIdle.map(({ actorId }) => actorId)).toEqual([
      shortLived.id,
      spawning.id,
      unknownTtl.id,
    ]);

    const late = allocate(
      [exactBoundary],
      [makeContract("contract:deadline-missed", { deadline: 107, estimatedWorkTicks: 5 })],
      travel,
    );
    expect(late.assignments).toEqual([]);
    expect(late.deferred).toEqual([
      { contractId: "contract:deadline-missed", reason: "no-viable-actor" },
    ]);
  });

  it("aligns incumbent travel evidence from Observe with the current Execute opportunity", () => {
    const contract = makeContract("contract:travel-progress", {
      deadline: 108,
      estimatedWorkTicks: 5,
      lease: {
        actorId: "actor:progressing",
        actorName: "actor:progressing",
        assignedAt: 100,
        assignmentCost: 3,
        expiresAt: 109,
        travelTicks: 3,
      },
      state: "assigned",
    });

    // Tick 101 Observe still sees the pre-movement position. Reconcile follows Execute, so the
    // current modeled movement leaves two travel and five work ticks through deadline 108.
    expect(remainingModeledTicks(contract, 101, 3)).toBe(7);
    expect(remainingModeledTicks(contract, 102, 2)).toBe(6);
    // If tick 101 produced no movement, tick 102 observes one tick of real delay.
    expect(remainingModeledTicks(contract, 102, 3)).toBe(7);
  });

  it("fails closed when travel evidence is unavailable", () => {
    const contract = makeContract("contract:unknown-travel");
    const actor = makeActor("actor:unknown-travel");

    const result = allocate(
      [actor],
      [contract],
      travelView(() => null),
    );

    expect(result.assignments).toEqual([]);
    expect(result.deferred).toEqual([{ contractId: contract.id, reason: "no-viable-actor" }]);
    expect(result.safeIdle).toEqual([{ actorId: actor.id, reason: "no-funded-contract" }]);
  });

  it("uses travel and switching cost before stable actor-id tie breaks", () => {
    const travelContract = makeContract("contract:travel");
    const fartherStableId = makeActor("actor:a-far");
    const nearerLaterId = makeActor("actor:z-near");
    const travel = travelView((actor) => (actor.id === nearerLaterId.id ? 1 : 4));

    const travelResult = allocate([fartherStableId, nearerLaterId], [travelContract], travel);
    expect(travelResult.assignments).toEqual([
      expect.objectContaining({ actorId: nearerLaterId.id, travelTicks: 1 }),
    ]);

    const incumbentActor = makeActor("actor:a-incumbent");
    const freeActor = makeActor("actor:z-free");
    const incumbentContract = makeContract("contract:incumbent", {
      lease: {
        actorId: incumbentActor.id,
        actorName: incumbentActor.name,
        assignedAt: 90,
        assignmentCost: 0,
        expiresAt: 150,
        travelTicks: 0,
      },
      leasePolicy: { duration: 20, switchingPenalty: 10, ttlSafetyMargin: 2 },
      priority: { class: "growth", value: 1 },
      state: "assigned",
    });
    const urgentContract = makeContract("contract:new-urgent", {
      priority: { class: "safety", value: 1 },
    });
    const switchingTravel = travelView((actor, contract) => {
      if (contract.id === urgentContract.id) {
        return actor.id === incumbentActor.id ? 0 : 2;
      }
      return actor.id === incumbentActor.id ? 0 : 10;
    });

    const forward = allocate(
      [freeActor, incumbentActor],
      [incumbentContract, urgentContract],
      switchingTravel,
    );
    const reordered = allocate(
      [incumbentActor, freeActor],
      [urgentContract, incumbentContract],
      switchingTravel,
    );
    const assignments = Object.fromEntries(
      forward.assignments.map(({ actorId, contractId }) => [contractId, actorId]),
    );

    expect(reordered).toEqual(forward);
    expect(assignments).toEqual({
      [incumbentContract.id]: incumbentActor.id,
      [urgentContract.id]: freeActor.id,
    });
    expect(forward.acceptedAssignmentCost).toBe(2);
  });

  it("orders capability surplus, TTL slack, cost ceiling, and actor ID exactly", () => {
    const contract = makeContract("contract:bid-order", {
      leasePolicy: { duration: 10, switchingPenalty: 0, ttlSafetyMargin: 0 },
    });
    const overqualifiedLowerId = makeActor("actor:a-overqualified", {
      capability: capability({ move: 1, work: 2 }),
    });
    const exactHigherId = makeActor("actor:z-exact", {
      capability: capability({ move: 1, work: 1 }),
    });
    expect(allocate([overqualifiedLowerId, exactHigherId], [contract]).assignments).toEqual([
      expect.objectContaining({ actorId: exactHigherId.id }),
    ]);

    const longLivedLowerId = makeActor("actor:a-long", { ticksToLive: 100 });
    const exactTtlHigherId = makeActor("actor:z-tight", { ticksToLive: 6 });
    expect(allocate([longLivedLowerId, exactTtlHigherId], [contract]).assignments).toEqual([
      expect.objectContaining({ actorId: exactTtlHigherId.id }),
    ]);

    const equalA = makeActor("actor:a-equal");
    const equalZ = makeActor("actor:z-equal");
    expect(allocate([equalZ, equalA], [contract]).assignments).toEqual([
      expect.objectContaining({ actorId: equalA.id }),
    ]);

    const overCost = makeContract("contract:over-cost", { maxAssignmentCost: 1 });
    expect(
      allocate(
        [equalA],
        [overCost],
        travelView(() => 2),
      ).assignments,
    ).toEqual([]);
  });

  it("emits a bounded data-only safe-idle disposition for unassigned actors", () => {
    const contract = makeContract("contract:single");
    const assigned = makeActor("actor:a-assigned");
    const idle = makeActor("actor:z-idle");

    const result = allocate([idle, assigned], [contract]);

    expect(result.assignments).toEqual([
      expect.objectContaining({ actorId: assigned.id, contractId: contract.id }),
    ]);
    expect(result.safeIdle).toEqual([{ actorId: idle.id, reason: "no-funded-contract" }]);
    expect(Object.keys(result.safeIdle[0] ?? {}).sort()).toEqual(["actorId", "reason"]);
    expect(Object.getPrototypeOf(result.safeIdle[0])).toBe(Object.prototype);
    expect(Object.isFrozen(result.safeIdle[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(result.safeIdle))).toEqual(result.safeIdle);
  });

  it("canonicalizes oversized inputs before enforcing actor, contract, and pair caps", () => {
    const actors = Array.from({ length: MAX_ALLOCATION_ACTORS + 2 }, (_, index) =>
      makeActor(`actor:${pad(index)}`, { capability: capability() }),
    );
    const contracts = Array.from({ length: MAX_ALLOCATION_CONTRACTS + 2 }, (_, index) =>
      makeContract(`contract:${pad(index)}`),
    );

    const forward = allocate(actors, contracts);
    const reordered = allocate([...actors].reverse(), [...contracts].reverse());

    expect(reordered).toEqual(forward);
    expect(forward.assignments).toEqual([]);
    expect(forward.evaluatedPairs).toBe(MAX_ALLOCATION_PAIRS);
    expect(forward.evaluatedPairs).toBeLessThanOrEqual(MAX_ALLOCATION_PAIRS);
    expect(forward.truncatedActors).toBe(2);
    expect(forward.truncatedContracts).toBe(2);
    expect(forward.safeIdle).toHaveLength(MAX_SAFE_IDLE_ACTORS);
    expect(forward.deferred.filter(({ reason }) => reason === "contract-capacity")).toHaveLength(2);
    expect(forward.deferred.filter(({ reason }) => reason === "no-viable-actor")).toHaveLength(
      MAX_ALLOCATION_CONTRACTS,
    );
  });

  it("reserves actor-cap consideration for a valid incumbent lease", () => {
    const incumbent = makeActor("actor:z-incumbent");
    const lowerIds = Array.from({ length: MAX_ALLOCATION_ACTORS }, (_, index) =>
      makeActor(`actor:a-${pad(index)}`),
    );
    const contract = makeContract("contract:incumbent-cap", {
      lease: {
        actorId: incumbent.id,
        actorName: incumbent.name,
        assignedAt: 90,
        assignmentCost: 0,
        expiresAt: 150,
        travelTicks: 0,
      },
      state: "assigned",
    });

    const result = allocate([...lowerIds, incumbent], [contract]);

    expect(result.truncatedActors).toBe(1);
    expect(result.assignments).toEqual([
      expect.objectContaining({ actorId: incumbent.id, contractId: contract.id }),
    ]);
  });

  it("preserves a capacity-deferred incumbent that is not preempted", () => {
    const incumbent = makeActor("actor:incumbent");
    const higher = Array.from({ length: MAX_ALLOCATION_CONTRACTS }, (_, index) =>
      makeContract(`contract:${pad(index)}`, {
        requiredCapability: capability({ attack: 1 }),
      }),
    );
    const deferred = makeContract("contract:zzz-deferred", {
      lease: {
        actorId: incumbent.id,
        actorName: incumbent.name,
        assignedAt: 90,
        assignmentCost: 0,
        expiresAt: 150,
        travelTicks: 0,
      },
      state: "assigned",
    });

    const result = allocate([incumbent], [...higher, deferred]);

    expect(result.truncatedContracts).toBe(1);
    expect(result.preservedContractIds).toEqual([deferred.id]);
    expect(result.safeIdle).toEqual([]);
    expect(result.deferred).toContainEqual({
      contractId: deferred.id,
      reason: "contract-capacity",
    });
  });
});

function allocate(
  actors: readonly WorkforceActor[],
  contracts: readonly WorkContractRecord[],
  travel: TravelEstimateView = travelView(() => 0),
): WorkforceAllocationResult {
  return new WorkforceAllocator().allocate({ actors, contracts, tick: TICK, travel });
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

function makeActor(id: string, overrides: Partial<WorkforceActor> = {}): WorkforceActor {
  return {
    capability: capability({ move: 1, work: 1 }),
    id,
    name: id,
    pos: { roomName: "W1N1", x: 20, y: 20 },
    spawning: false,
    ticksToLive: 100,
    ...overrides,
  };
}

function makeContract(id: string, overrides: Partial<WorkContractRecord> = {}): WorkContractRecord {
  const base: WorkContractRecord = {
    budgetBinding: { category: "harvesting-filling", issuer: "test:budget" },
    conditions: { cancellation: null, failure: null, success: "work-complete" },
    deadline: 200,
    earliestStart: 0,
    estimatedWorkTicks: 5,
    expiresAt: 201,
    history: [],
    id,
    issuer: "test:allocator",
    issuerKey: id,
    issuerSequence: 1,
    kind: "harvest",
    lease: null,
    leasePolicy: { duration: 10, switchingPenalty: 4, ttlSafetyMargin: 2 },
    maxAssignmentCost: 100,
    owner: { id: "W1N1", kind: "colony" },
    preconditionKeys: [],
    priority: { class: "survival", value: 100 },
    quantity: 1,
    range: 1,
    requestSignature: `signature:${id}`,
    requiredCapability: capability({ work: 1 }),
    revision: 1,
    state: "funded",
    target: { roomName: "W1N1", x: 25, y: 25 },
    targetId: null,
  };

  return { ...base, ...overrides };
}

function travelView(
  estimate: (actor: WorkforceActor, contract: WorkContractRecord) => number | null,
): TravelEstimateView {
  return { estimate };
}

function pad(value: number): string {
  return value.toString().padStart(3, "0");
}
