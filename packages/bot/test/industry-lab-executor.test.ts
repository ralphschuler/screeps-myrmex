import { describe, expect, it, vi } from "vitest";
import {
  executeLabIntents,
  type LabBoostCreepIntent,
  type LabRunReactionIntent,
} from "../src/industry";
import type { ArbitrationBatch } from "../src/execution";

describe("lab executor", () => {
  it("issues one accepted reaction and preserves exact return-code normalization", () => {
    const product = lab("product", null, 0, 0);
    const reagentA = lab("a", "U", 100, 0);
    const reagentB = lab("b", "H", 100, 0);
    const runReaction = vi.fn((): ScreepsReturnCode => -11);
    product.runReaction = runReaction;
    const results = executeLabIntents(
      batch(reactionIntent()),
      100,
      adapter([product, reagentA, reagentB]),
    );
    expect(runReaction).toHaveBeenCalledOnce();
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: "ERR_TIRED",
      returnCode: -11,
    });
  });

  it("fails closed before the API call when observed reaction amounts drift", () => {
    const product = lab("product", null, 0, 0);
    const reagentA = lab("a", "U", 95, 0);
    const reagentB = lab("b", "H", 100, 0);
    const runReaction = vi.fn((): ScreepsReturnCode => 0);
    product.runReaction = runReaction;
    const results = executeLabIntents(
      batch(reactionIntent()),
      100,
      adapter([product, reagentA, reagentB]),
    );
    expect(runReaction).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: "rejected", reason: "ERR_INVALID_TARGET" });
  });

  it("boosts only the explicit eligible part count after fingerprint revalidation", () => {
    const boostLab = lab("boost", "XUH2O", 300, 200);
    const creep = {
      id: "creep/1",
      spawning: false,
      pos: position(),
      body: Array.from({ length: 10 }, () => ({ type: "attack", hits: 100 })),
    } as unknown as Creep;
    const boostCreep = vi.fn((): ScreepsReturnCode => 0);
    boostLab.boostCreep = boostCreep;
    const results = executeLabIntents(batch(boostIntent()), 100, adapter([boostLab], [creep]));
    expect(boostCreep).toHaveBeenCalledWith(creep, 10);
    expect(results[0]).toMatchObject({ status: "executed", reason: "OK" });
  });

  it("never executes rejected or unrelated intents", () => {
    const product = lab("product", null, 0, 0);
    const runReaction = vi.fn((): ScreepsReturnCode => 0);
    product.runReaction = runReaction;
    const result = executeLabIntents(
      { ...batch(reactionIntent()), accepted: [] },
      100,
      adapter([product]),
    );
    expect(result).toEqual([]);
    expect(runReaction).not.toHaveBeenCalled();
  });
});

function reactionIntent(): LabRunReactionIntent {
  return {
    ...base("lab.run-reaction", "product"),
    payload: {
      amount: 5,
      assignmentFingerprint: "cluster-v1",
      catalogFingerprint: "catalog-v1",
      commitmentFingerprint: "objective-v1",
      objectiveId: "reaction/1",
      objectiveRevision: 1,
      product: "UH",
      productLabId: "product",
      productMineralBefore: 0,
      reagentLabIds: ["a", "b"],
      reagentMineralsBefore: [100, 100],
      reagents: ["U", "H"],
      roomName: "W1N1",
    },
  };
}

function boostIntent(): LabBoostCreepIntent {
  return {
    ...base("lab.boost-creep", "creep/1"),
    priority: { class: "defense", value: 100 },
    payload: {
      assignmentFingerprint: "cluster-v1",
      bodyPartsCount: 10,
      catalogFingerprint: "catalog-v1",
      commitmentFingerprint: "boost-v1",
      compound: "XUH2O",
      creepFingerprint: "fingerprint/1",
      creepId: "creep/1",
      energyBefore: 200,
      labId: "boost",
      mineralBefore: 300,
      objectiveId: "boost/1",
      objectiveRevision: 1,
      partType: "attack",
      roomName: "W1N1",
      targetBoostedPartsBefore: 0,
    },
  };
}

function base<Kind extends string>(kind: Kind, target: string) {
  return {
    id: `intent/${kind}`,
    kind,
    issuer: "industry/W1N1/labs",
    tick: 100,
    target,
    snapshotRevision: "snapshot/100",
    exclusiveResourceKey: "lab-cluster/W1N1/cluster-v1",
    priority: { class: "speculation" as const, value: 10 },
    deadline: 100,
    budget: { id: "industry/labs", cost: 1 },
    preconditions: [],
  };
}

function batch(intent: LabRunReactionIntent | LabBoostCreepIntent): ArbitrationBatch {
  return {
    tick: 100,
    submitted: 1,
    acceptedBudget: 1,
    accepted: [intent],
    decisions: [],
  };
}

function adapter(labs: StructureLab[], creeps: Creep[] = []) {
  return {
    resolveLab: (id: string) => labs.find((value) => value.id === id) ?? null,
    resolveCreep: (id: string) => creeps.find((value) => value.id === id) ?? null,
    creepFingerprint: () => "fingerprint/1",
  };
}

function lab(
  id: string,
  mineralType: string | null,
  mineralAmount: number,
  energy: number,
): StructureLab {
  const value = {
    id,
    my: true,
    cooldown: 0,
    mineralType,
    mineralAmount,
    pos: position(),
    isActive: () => true,
    store: {
      getFreeCapacity: () => 3000 - mineralAmount,
      getUsedCapacity: (resource?: string) => (resource === "energy" ? energy : mineralAmount),
    },
    runReaction: vi.fn(() => 0),
    boostCreep: vi.fn(() => 0),
  };
  return value as unknown as StructureLab;
}

function position(): RoomPosition {
  return { getRangeTo: () => 1 } as unknown as RoomPosition;
}
