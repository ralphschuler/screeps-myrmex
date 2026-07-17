import { describe, expect, it } from "vitest";
import {
  emptyIndustryOwner,
  MAX_INDUSTRY_COMMAND_STATES,
  parseIndustryOwner,
  persistIndustryCommands,
  type IndustryCommandState,
} from "../src/industry";

describe("industry persistence", () => {
  const command = (identity: string): IndustryCommandState => ({
    attempt: 1,
    identity,
    lastCode: "ERR_TIRED",
    nextEligibleTick: 102,
    status: "backoff",
  });

  it("round-trips canonical bounded command state across a heap reset", () => {
    const owner = persistIndustryCommands(emptyIndustryOwner(), "industry-policy-v1", [
      command("send/b"),
      command("send/a"),
    ]);
    expect(parseIndustryOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(owner.commands.map(({ identity }) => identity)).toEqual(["send/a", "send/b"]);
  });

  it("drops commands when the source policy version changes", () => {
    const current = persistIndustryCommands(emptyIndustryOwner(), "industry-policy-v1", [
      command("send/a"),
    ]);
    expect(persistIndustryCommands(current, "industry-policy-v2", current.commands)).toMatchObject({
      policySourceVersion: "industry-policy-v2",
      commands: [],
    });
  });

  it("rejects malformed owners and caps newly persisted state", () => {
    const commands = Array.from({ length: MAX_INDUSTRY_COMMAND_STATES + 5 }, (_, index) =>
      command(`send/${String(index).padStart(3, "0")}`),
    );
    expect(
      persistIndustryCommands(emptyIndustryOwner(), "industry-policy-v1", commands).commands,
    ).toHaveLength(MAX_INDUSTRY_COMMAND_STATES);
    expect(
      parseIndustryOwner({
        ...emptyIndustryOwner(),
        commands: [{ ...command("send/a"), nextEligibleTick: -1 }],
      }),
    ).toBeNull();
  });
});
