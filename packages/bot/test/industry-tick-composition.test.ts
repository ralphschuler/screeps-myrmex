import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { projectIndustryTickPlan } from "../src/runtime/tick";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("industry tick composition", () => {
  it("derives bounded extraction and internal balancing from current owned-room stock", () => {
    const projection = projectIndustryTickPlan({
      policy: buildRuntimeConfig().policy.industry,
      previous: [],
      snapshot: snapshot(8_000, 0),
      tick: 100,
      transactionCost: () => 250,
    });

    expect(projection.plan.extraction.map(({ roomName }) => roomName)).toEqual(["W2N2"]);
    expect(projection.eligiblePlan.sends).toEqual([
      expect.objectContaining({
        amount: 5_000,
        destinationRoom: "W2N2",
        sourceRoom: "W1N1",
        transactionEnergy: 250,
      }),
    ]);
  });

  it("suppresses sends from or to a layout-reserved terminal room", () => {
    const policy = buildRuntimeConfig().policy.industry;
    for (const roomName of ["W1N1", "W2N2"]) {
      const projection = projectIndustryTickPlan({
        policy,
        previous: [],
        snapshot: snapshot(8_000, 0),
        terminalSendBlockedRoomNames: new Set([roomName]),
        tick: 100,
        transactionCost: () => 250,
      });

      expect(projection.plan.sends).toEqual([]);
      expect(projection.plan.deferrals).toContainEqual({
        count: 1,
        reason: "terminal-reserved",
      });
    }
  });

  it("suppresses backoff sends and rejects transaction costs above the configured ceiling", () => {
    const policy = buildRuntimeConfig().policy.industry;
    const baseline = projectIndustryTickPlan({
      policy,
      previous: [],
      snapshot: snapshot(8_000, 0),
      tick: 100,
      transactionCost: () => 250,
    });
    const identity = baseline.plan.sends[0]?.identity;
    if (identity === undefined) throw new Error("expected internal send fixture");
    const backedOff = projectIndustryTickPlan({
      policy,
      previous: [
        {
          attempt: 1,
          identity,
          lastCode: "ERR_INVALID_TARGET",
          nextEligibleTick: 102,
          status: "backoff",
        },
      ],
      snapshot: snapshot(8_000, 0),
      tick: 101,
      transactionCost: () => 250,
    });
    const expensive = projectIndustryTickPlan({
      policy,
      previous: [],
      snapshot: snapshot(8_000, 0),
      tick: 101,
      transactionCost: () => policy.maximumTransactionEnergyPerSend + 1,
    });

    expect(backedOff.plan.sends).toHaveLength(1);
    expect(backedOff.eligiblePlan.sends).toEqual([]);
    expect(expensive.plan.sends).toEqual([]);
    expect(expensive.plan.deferrals).toContainEqual({ count: 1, reason: "insufficient-energy" });
  });
});

function snapshot(sourceStock: number, destinationStock: number): WorldSnapshot {
  return {
    ownedRooms: [room("W1N1", sourceStock), room("W2N2", destinationStock)],
  } as unknown as WorldSnapshot;
}

function room(name: string, mineralStock: number) {
  return {
    name,
    controller: { level: 6, ownership: "owned" },
    mineral: {
      amount: 10_000,
      id: `mineral-${name}`,
      mineralType: "H",
      pos: { roomName: name, x: 20, y: 20 },
      ticksToRegeneration: null,
    },
    ownedExtractors: [
      {
        active: true,
        cooldown: 0,
        id: `extractor-${name}`,
        pos: { roomName: name, x: 20, y: 20 },
      },
    ],
    ownedStorages: [],
    ownedTerminals: [
      {
        active: true,
        cooldown: 0,
        id: `terminal-${name}`,
        store: {
          freeCapacity: 100_000,
          resources: [
            { amount: 20_000, resourceType: "energy" },
            { amount: mineralStock, resourceType: "H" },
          ],
        },
      },
    ],
  };
}
