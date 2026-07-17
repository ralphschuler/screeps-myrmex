import { describe, expect, it } from "vitest";
import {
  IndustryDirector,
  type IndustryPlannerInput,
  type IndustryRoomState,
  type InternalSendRequest,
} from "../src/industry";

const LIMITS = {
  maxExtractionProposals: 4,
  maxRoomsScanned: 4,
  maxSendProposals: 4,
  maxSendRequestsScanned: 8,
};

describe("IndustryDirector stock policy", () => {
  it("extracts only a funded deficit with active RCL6 capacity", () => {
    const director = new IndustryDirector();
    const eligible = director.plan(input([room("W1N1")], []));

    expect(eligible.extraction).toEqual([
      {
        amount: 300,
        identity: "industry/extract/W1N1/mineral-W1N1/H",
        mineralId: "mineral-W1N1",
        resourceType: "H",
        roomName: "W1N1",
      },
    ]);
    expect(eligible.accounting).toMatchObject({ mined: 300, reserved: 300 });

    expect(
      director.plan(input([room("W1N1", { mineralAmount: 0, regeneration: 50_000 })], []))
        .deferrals,
    ).toContainEqual({ count: 1, reason: "regenerating" });
    expect(
      director.plan(input([room("W1N1", { controllerLevel: 5 })], [])).deferrals,
    ).toContainEqual({ count: 1, reason: "rcl" });
    expect(director.plan(input([room("W1N1", { freeCapacity: 0 })], [])).deferrals).toContainEqual({
      count: 1,
      reason: "destination-capacity",
    });
    expect(
      director.plan(input([room("W1N1", { mineralStock: 800 })], [])).deferrals,
    ).toContainEqual({ count: 1, reason: "stock-limit" });
  });

  it("bounds internal sends by bands, capacity, cooldown, and protected energy", () => {
    const director = new IndustryDirector();
    const request = send("send-H", "H", 400);
    const planned = director.plan(
      input(
        [
          room("W1N1", { mineralStock: 800, terminalEnergy: 500 }),
          room("W2N2", { mineralStock: 100, terminalEnergy: 300 }),
        ],
        [request],
      ),
    );

    expect(planned.sends).toEqual([
      expect.objectContaining({
        amount: 400,
        identity: "industry/send/send-H/W1N1/W2N2/H",
        transactionEnergy: 40,
      }),
    ]);
    expect(planned.accounting).toMatchObject({ sent: 400, transactionEnergy: 40 });

    const energySend = director.plan(
      input(
        [
          room("W1N1", { mineralStock: 800, terminalEnergy: 500 }),
          room("W2N2", { mineralStock: 100, terminalEnergy: 300 }),
        ],
        [send("send-energy", "energy", 300)],
      ),
    );
    expect(energySend.sends[0]).toMatchObject({ amount: 181, transactionEnergy: 19 });

    expect(
      director.plan(
        input(
          [
            room("W1N1", { mineralStock: 800, terminalCooldown: 5 }),
            room("W2N2", { mineralStock: 100 }),
          ],
          [request],
        ),
      ).deferrals,
    ).toContainEqual({ count: 1, reason: "cooldown" });
    expect(
      director.plan({
        ...input(
          [room("W1N1", { mineralStock: 800 }), room("W2N2", { mineralStock: 100 })],
          [request],
        ),
        transactionCost: (amount) => amount * 1_000,
      }).deferrals,
    ).toContainEqual({ count: 1, reason: "insufficient-energy" });
    expect(
      director.plan(input([room("W1N1", { mineralStock: 800 })], [request])).deferrals,
    ).toContainEqual({ count: 1, reason: "missing-destination" });
  });

  it("is capped and identical after reorder and JSON reset", () => {
    const rooms = [
      room("W2N2", { mineralStock: 100 }),
      room("W1N1", { mineralStock: 800, terminalEnergy: 500 }),
    ];
    const requests = [send("later", "H", 100, 1_020), send("first", "H", 200, 1_010)];
    const baseline = new IndustryDirector().plan(input(rooms, requests));
    const reordered = new IndustryDirector().plan(
      input([...rooms].reverse(), [...requests].reverse()),
    );
    const resetData = JSON.parse(
      JSON.stringify({ limits: LIMITS, requests, rooms, tick: 1_000 }),
    ) as Omit<IndustryPlannerInput, "transactionCost">;
    const reset = new IndustryDirector().plan({
      ...resetData,
      transactionCost: (amount) => Math.ceil(amount / 10),
    });

    expect(reordered).toEqual(baseline);
    expect(reset).toEqual(baseline);
    expect(baseline.sends).toHaveLength(1);
    expect(baseline.sends[0]?.requestId).toBe("first");

    const capped = new IndustryDirector().plan({
      ...input(rooms, requests),
      limits: { ...LIMITS, maxRoomsScanned: 1, maxSendRequestsScanned: 1 },
    });
    expect(capped.scannedRooms).toBe(1);
    expect(capped.scannedSendRequests).toBe(1);
    expect(capped.deferrals).toContainEqual({ count: 2, reason: "scan-limit" });
  });
});

function input(
  rooms: readonly IndustryRoomState[],
  requests: readonly InternalSendRequest[],
): IndustryPlannerInput {
  return {
    limits: LIMITS,
    requests,
    rooms,
    tick: 1_000,
    transactionCost: (amount) => Math.ceil(amount / 10),
  };
}

function send(id: string, resourceType: string, amount: number, deadline = 1_010) {
  return { amount, deadline, destinationRoom: "W2N2", id, resourceType, sourceRoom: "W1N1" };
}

function room(
  roomName: string,
  options: {
    controllerLevel?: number;
    freeCapacity?: number;
    mineralAmount?: number;
    mineralStock?: number;
    regeneration?: number | null;
    terminalCooldown?: number;
    terminalEnergy?: number;
  } = {},
): IndustryRoomState {
  const mineralStock = options.mineralStock ?? 100;
  const freeCapacity = options.freeCapacity ?? 1_000;
  return {
    bands: [
      { resourceType: "energy", min: 300, target: 500, max: 1_000 },
      { resourceType: "H", min: 200, target: 500, max: 800 },
    ],
    commitments: [{ amount: 400, fundedAmount: 300, id: "labs/H", resourceType: "H" }],
    controllerLevel: options.controllerLevel ?? 6,
    extractor: { active: true, cooldown: 0 },
    mineral: {
      amount: options.mineralAmount ?? 1_000,
      id: `mineral-${roomName}`,
      resourceType: "H",
      ticksToRegeneration: options.regeneration ?? null,
    },
    protectedEnergy: 300,
    roomName,
    storage: { active: true, freeCapacity, stocks: [] },
    terminal: {
      active: true,
      cooldown: options.terminalCooldown ?? 0,
      freeCapacity,
      stocks: [
        { amount: mineralStock, resourceType: "H" },
        { amount: options.terminalEnergy ?? 500, resourceType: "energy" },
      ],
    },
  };
}
