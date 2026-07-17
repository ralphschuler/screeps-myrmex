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
} from "../src/industry";

describe("industry persistence", () => {
  const command = (identity: string): IndustryCommandState => ({
    attempt: 1,
    identity,
    lastCode: "ERR_TIRED",
    nextEligibleTick: 102,
    status: "backoff",
  });

  it("round-trips canonical bounded command and lab state across a heap reset", () => {
    const owner = persistIndustryOwner(
      emptyIndustryOwner(),
      "industry-policy-v2",
      [command("send/b"), command("send/a")],
      [commitment("z"), commitment("a")],
    );
    expect(parseIndustryOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(owner.commands.map(({ identity }) => identity)).toEqual(["send/a", "send/b"]);
    expect(owner.labCommitments.map(({ objectiveId }) => objectiveId)).toEqual(["a", "z"]);
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
      schemaVersion: 2,
      revision: 8,
      policySourceVersion: "industry-policy-v2",
      commands: [{ identity: "send/a" }, { identity: "send/b" }],
      labCommitments: [],
    });
    expect(migrateIndustryOwner(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
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
