import { describe, expect, it } from "vitest";
import {
  emptyIndustryOwner,
  MAX_INDUSTRY_COMMAND_STATES,
  migrateIndustryOwner,
  parseIndustryOwner,
  persistIndustryCommands,
  persistIndustryOwner,
  type IndustryCommandState,
  type LabPolicyCommitment,
  type PendingLabAttempt,
} from "../src/industry";
import type { PendingMatureAttempt } from "../src/industry/mature-attempt";
import type { MaturePolicyCommitment } from "../src/industry/mature-policy";
import type { PendingObserverAttempt } from "../src/observer";

describe("industry persistence", () => {
  const command = (identity: string): IndustryCommandState => ({
    attempt: 1,
    identity,
    lastCode: "ERR_TIRED",
    nextEligibleTick: 102,
    status: "backoff",
  });

  it("round-trips every canonical industry commitment and pending receipt across a heap reset", () => {
    const owner = persistIndustryOwner(
      emptyIndustryOwner(),
      "industry-policy-v2",
      [command("send/b"), command("send/a")],
      [commitment("z"), commitment("a")],
      [attempt("z"), attempt("a")],
      [matureAttempt("z"), matureAttempt("a")],
      [matureCommitment("z"), matureCommitment("a")],
      [observerAttempt("z"), observerAttempt("a")],
    );
    expect(parseIndustryOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(owner.schemaVersion).toBe(5);
    expect(owner.commands.map(({ identity }) => identity)).toEqual(["send/a", "send/b"]);
    expect(owner.labCommitments.map(({ objectiveId }) => objectiveId)).toEqual(["a", "z"]);
    expect(owner.labAttempts.map(({ attemptId }) => attemptId)).toEqual(["attempt/a", "attempt/z"]);
    expect(owner.matureAttempts.map(({ attemptId }) => attemptId)).toEqual([
      "mature-attempt/a",
      "mature-attempt/z",
    ]);
    expect(owner.matureCommitments.map(({ objective }) => objective.id)).toEqual([
      "mature-objective/a",
      "mature-objective/z",
    ]);
    expect(owner.observerAttempts.map(({ attemptId }) => attemptId)).toEqual([
      "observer-attempt/a",
      "observer-attempt/z",
    ]);
  });

  it("migrates V1 locally and preserves terminal retry state idempotently", () => {
    const v1 = {
      schemaVersion: 1,
      revision: 7,
      policySourceVersion: "industry-policy-v1",
      commands: [command("send/b"), command("send/a")],
    };
    const migrated = migrateIndustryOwner(v1);
    expect(migrated).toMatchObject({
      schemaVersion: 5,
      revision: 8,
      policySourceVersion: "industry-policy-v2",
      commands: [{ identity: "send/a" }, { identity: "send/b" }],
      labCommitments: [],
      labAttempts: [],
      matureAttempts: [],
      matureCommitments: [],
      observerAttempts: [],
    });
    expect(migrateIndustryOwner(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
  });

  it("migrates V2 commitments without inventing pending effects", () => {
    const migrated = migrateIndustryOwner({
      schemaVersion: 2,
      revision: 9,
      policySourceVersion: "industry-policy-v2",
      commands: [command("send/a")],
      labCommitments: [commitment("reaction")],
    });
    expect(migrated).toMatchObject({
      schemaVersion: 5,
      revision: 10,
      labCommitments: [{ objectiveId: "reaction" }],
      labAttempts: [],
      matureAttempts: [],
      matureCommitments: [],
      observerAttempts: [],
    });
  });

  it("migrates V3 lab attempts without inventing mature command effects", () => {
    const migrated = migrateIndustryOwner({
      schemaVersion: 3,
      revision: 11,
      policySourceVersion: "industry-policy-v2",
      commands: [command("send/a")],
      labCommitments: [commitment("reaction")],
      labAttempts: [attempt("reaction")],
    });
    expect(migrated).toMatchObject({
      schemaVersion: 5,
      revision: 12,
      labAttempts: [{ attemptId: "attempt/reaction" }],
      matureAttempts: [],
      matureCommitments: [],
      observerAttempts: [],
    });
  });

  it("migrates V4 attempts without inventing commitments or observer effects", () => {
    const migrated = migrateIndustryOwner({
      schemaVersion: 4,
      revision: 13,
      policySourceVersion: "industry-policy-v2",
      commands: [command("send/a")],
      labCommitments: [commitment("reaction")],
      labAttempts: [attempt("reaction")],
      matureAttempts: [matureAttempt("factory")],
    });
    expect(migrated).toMatchObject({
      schemaVersion: 5,
      revision: 14,
      matureAttempts: [{ attemptId: "mature-attempt/factory" }],
      matureCommitments: [],
      observerAttempts: [],
    });
  });

  it("retires incompatible state when a later source policy changes", () => {
    const current = persistIndustryOwner(
      emptyIndustryOwner(),
      "industry-policy-v2",
      [command("send/a")],
      [commitment("reaction")],
    );
    expect(persistIndustryCommands(current, "industry-policy-v3", current.commands)).toMatchObject({
      policySourceVersion: "industry-policy-v3",
      commands: [],
      labCommitments: [],
      labAttempts: [],
      matureAttempts: [],
      matureCommitments: [],
      observerAttempts: [],
    });
  });

  it("rejects malformed/future owners and caps newly persisted command state", () => {
    const commands = Array.from({ length: MAX_INDUSTRY_COMMAND_STATES + 5 }, (_, index) =>
      command(`send/${String(index).padStart(3, "0")}`),
    );
    expect(
      persistIndustryCommands(emptyIndustryOwner(), "industry-policy-v2", commands).commands,
    ).toHaveLength(MAX_INDUSTRY_COMMAND_STATES);
    expect(
      migrateIndustryOwner({
        ...emptyIndustryOwner(),
        commands: [{ ...command("send/a"), nextEligibleTick: -1 }],
      }),
    ).toBeNull();
    expect(
      migrateIndustryOwner({
        ...emptyIndustryOwner(),
        matureAttempts: [{ ...matureAttempt("bad"), storeUsedBefore: 141 }],
      }),
    ).toBeNull();
    expect(migrateIndustryOwner({ schemaVersion: 99, revision: 1 })).toBeNull();
  });
});

function commitment(objectiveId: string): LabPolicyCommitment {
  return {
    assignmentFingerprint: "cluster-v1",
    batchAmount: 300,
    catalogFingerprint: "catalog-v1",
    colonyId: "W1N1",
    deadline: 500,
    kind: "reaction",
    objectiveFingerprint: `objective:${objectiveId}`,
    objectiveId,
    objectiveRevision: 1,
    priority: 10,
    product: "UH",
    reagents: ["U", "H"],
    settledAmount: 0,
    targetProduct: "XUH2O",
  };
}

function matureAttempt(objectiveId: string): PendingMatureAttempt {
  return {
    attemptId: `mature-attempt/${objectiveId}`,
    capabilityFingerprint: "factory-capability",
    commitmentFingerprint: `mature-objective:${objectiveId}`,
    issuedAt: 100,
    mechanicsFingerprint: "mechanics-v1",
    objectiveId,
    objectiveRevision: 1,
    observeAt: 101,
    retry: 0,
    roomName: "W1N1",
    snapshotRevision: "snapshot/100",
    structureId: "factory",
    batchAmount: 20,
    components: [
      { amount: 40, resourceType: "energy" },
      { amount: 100, resourceType: "silicon" },
    ],
    cooldown: 8,
    kind: "factory",
    product: "wire",
    resourcesBefore: [
      { amount: 40, resourceType: "energy" },
      { amount: 100, resourceType: "silicon" },
      { amount: 0, resourceType: "wire" },
    ],
    storeCapacity: 50_000,
    storeUsedBefore: 140,
  };
}

function matureCommitment(objectiveId: string): MaturePolicyCommitment {
  return {
    objective: {
      batches: 1,
      colonyId: "W1N1",
      deadline: 150,
      endpointId: "storage",
      funded: true,
      id: `mature-objective/${objectiveId}`,
      industryBudgetId: `mature-budget/${objectiveId}`,
      kind: "factory-batch",
      mechanicsFingerprint: "mechanics-v1",
      priority: "normal",
      product: "wire",
      revision: 1,
      structureId: "factory",
    },
    status: "ready",
  };
}

function observerAttempt(requestId: string): PendingObserverAttempt {
  return {
    attemptId: `observer-attempt/${requestId}`,
    authorizationId: `observer-authorization/${requestId}`,
    authorizationRevision: 1,
    capabilityFingerprint: "observer-capability",
    deadline: 150,
    issuedAt: 100,
    issuer: "intel",
    mechanicsFingerprint: "mechanics-v1",
    observeAt: 101,
    observerId: "observer",
    originRoomName: "W1N1",
    requestId,
    requestRevision: 1,
    retry: 0,
    targetRoomName: "W2N2",
  };
}

function attempt(objectiveId: string): PendingLabAttempt {
  return {
    assignmentFingerprint: "cluster-v1",
    attemptId: `attempt/${objectiveId}`,
    catalogFingerprint: "catalog-v1",
    commitmentFingerprint: `objective:${objectiveId}`,
    issuedAt: 100,
    kind: "reaction",
    objectiveId,
    objectiveRevision: 1,
    observeAt: 101,
    product: "UH",
    productLabId: "lab/c",
    productMineralBefore: 0,
    reagentLabIds: ["lab/a", "lab/b"],
    reagentMineralsBefore: [100, 100],
    reagents: ["U", "H"],
    retry: 0,
    roomName: "W1N1",
    snapshotRevision: "snapshot/100",
  };
}
