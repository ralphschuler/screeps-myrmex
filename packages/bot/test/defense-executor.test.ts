import { describe, expect, it } from "vitest";
import { executeDefenseIntents } from "../src/defense/defense-executor";
import type { ArbitrationBatch, IntentEnvelope } from "../src/execution";
import type { DefenseIntentKind } from "../src/defense/director";

describe("executeDefenseIntents", () => {
  it("returns normalized tower command outcomes and continues after a command fault", () => {
    const intents = [
      repairIntent("a", "tower-a", "road-a"),
      repairIntent("b", "tower-b", "road-b"),
    ];
    let cpu = 0;
    const results = executeDefenseIntents(
      batch(intents),
      100,
      (id) =>
        id.startsWith("tower-")
          ? {
              attack: () => 0,
              heal: () => 0,
              repair: () => {
                cpu += 0.25;
                if (id === "tower-a") throw new Error("private target detail");
                return -9;
              },
            }
          : {},
      { getUsed: () => cpu },
    );

    expect(
      results.map(({ intentId, status, reason, cpuUsed }) => ({
        intentId,
        status,
        reason,
        cpuUsed,
      })),
    ).toEqual([
      { intentId: "a", status: "failed", reason: "adapter-fault", cpuUsed: 0.25 },
      { intentId: "b", status: "rejected", reason: "ERR_NOT_IN_RANGE", cpuUsed: 0.25 },
    ]);
    expect(results[0]?.outcome).toMatchObject({ state: "adapter-fault" });
  });

  it("returns one immutable empty result when no defense intent is accepted", () => {
    const results = executeDefenseIntents(batch([]), 101, () => null, { getUsed: () => 0 });
    expect(results).toEqual([]);
    expect(Object.isFrozen(results)).toBe(true);
  });
});

function repairIntent(
  id: string,
  towerId: string,
  target: string,
): IntentEnvelope<DefenseIntentKind> {
  return {
    id,
    kind: "tower.repair",
    issuer: "maintenance/W1N1",
    tick: 100,
    target,
    snapshotRevision: "world:100",
    exclusiveResourceKey: `tower/${towerId}`,
    priority: { class: "maintenance", value: 1 },
    deadline: 100,
    budget: { id: "maintenance-v2/W1N1", cost: 10 },
    preconditions: [],
    payload: { towerId },
  };
}

function batch(accepted: readonly IntentEnvelope<DefenseIntentKind>[]): ArbitrationBatch {
  return {
    tick: 100,
    submitted: accepted.length,
    acceptedBudget: accepted.length * 10,
    accepted,
    decisions: [],
  };
}
