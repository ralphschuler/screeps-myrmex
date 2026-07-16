import { describe, expect, it } from "vitest";
import type { MovementRuntimeResult } from "../src/movement";
import { measureSurvivalEnergyFlow } from "../src/telemetry/energy-flow";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("survival energy-flow measurement", () => {
  it("measures one unboosted WORK harvest in energy units rather than contract quantity", () => {
    expect(measureSurvivalEnergyFlow(snapshot(), movement("harvest", 1))).toEqual({
      carried: 10,
      delivered: 0,
      dropped: 3,
      harvested: 2,
      harvestedIsLowerBound: false,
      requested: 200,
      unmet: 200,
    });
    expect(
      measureSurvivalEnergyFlow(
        snapshot({ carried: 49, sourceEnergy: 1 }),
        movement("harvest", 50),
      ),
    ).toMatchObject({ carried: 49, harvested: 1 });
    expect(
      measureSurvivalEnergyFlow(snapshot({ boostedWork: 1 }), movement("harvest", 1)),
    ).toMatchObject({ harvested: 2, harvestedIsLowerBound: true });
  });

  it("clamps scheduled delivery to observed cargo and reports residual sink demand", () => {
    expect(measureSurvivalEnergyFlow(snapshot(), movement("transfer", 50))).toEqual({
      carried: 10,
      delivered: 10,
      dropped: 3,
      harvested: 0,
      harvestedIsLowerBound: false,
      requested: 200,
      unmet: 190,
    });
    expect(measureSurvivalEnergyFlow(snapshot(), movement("transfer", 1, "failed"))).toMatchObject({
      delivered: 0,
      requested: 200,
      unmet: 200,
    });
    expect(
      measureSurvivalEnergyFlow(snapshot({ spawnEnergy: 298 }), movement("transfer", 50)),
    ).toMatchObject({ delivered: 2, requested: 2, unmet: 0 });
    expect(measureSurvivalEnergyFlow(snapshot(), movement("transfer", 1))).toMatchObject({
      delivered: 1,
      requested: 200,
      unmet: 199,
    });

    const forward = movementResults([
      action("transfer", 7, "z-action"),
      action("transfer", 7, "a-action"),
    ]);
    const reversed = movementResults([...forward.actionExecution].reverse());
    expect(measureSurvivalEnergyFlow(snapshot(), forward)).toEqual(
      measureSurvivalEnergyFlow(snapshot(), reversed),
    );
    expect(measureSurvivalEnergyFlow(snapshot(), forward)).toMatchObject({ delivered: 10 });
  });

  it("ignores visible foreign-room stock and saturates owned refill demand", () => {
    const base = snapshot();
    const owned = base.ownedRooms[0];
    if (owned === undefined) throw new Error("expected owned-room fixture");
    const foreign = {
      ...owned,
      controller: { ...owned.controller, ownerUsername: "other", ownership: "foreign" as const },
      energyAvailable: 0,
      energyCapacityAvailable: 300,
      name: "W9N9",
      ownedCreeps: [],
    };
    const withForeign = { ...base, rooms: [foreign, ...base.rooms] };
    expect(measureSurvivalEnergyFlow(withForeign, movement("transfer", 1, "failed"))).toMatchObject(
      { carried: 10, dropped: 3, requested: 200 },
    );

    const saturatedRoom = {
      ...owned,
      energyAvailable: 0,
      energyCapacityAvailable: Number.MAX_SAFE_INTEGER,
    };
    const second = {
      ...saturatedRoom,
      controller: { ...saturatedRoom.controller, id: "controller-2" },
      name: "W2N2",
      ownedCreeps: [],
      ownedSpawns: [],
    };
    expect(
      measureSurvivalEnergyFlow(
        {
          ...base,
          ownedRooms: [second, saturatedRoom],
          rooms: [saturatedRoom, second],
        },
        movement("transfer", 1, "failed"),
      ).requested,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

function movement(
  kind: "harvest" | "transfer",
  amount: number,
  status: "executed" | "failed" = "executed",
): MovementRuntimeResult {
  return movementResults([action(kind, amount, `action:${kind}`, status)]);
}

function action(
  kind: "harvest" | "transfer",
  amount: number,
  id: string,
  status: "executed" | "failed" = "executed",
): MovementRuntimeResult["actionExecution"][number] {
  return {
    intent: {
      actorId: "worker",
      amount,
      contractId: "contract",
      contractRevision: 1,
      deadline: 100,
      id,
      kind,
      priority: 1,
      resourceType: kind === "transfer" ? "energy" : null,
      targetId: kind === "transfer" ? "spawn" : "source",
    },
    outcome: status === "executed" ? { code: 0, name: "OK", state: "scheduled" } : null,
    reason: status === "executed" ? "executed" : "adapter-fault",
    status,
  };
}

function movementResults(
  actionExecution: MovementRuntimeResult["actionExecution"],
): MovementRuntimeResult {
  return {
    actionDecisions: [],
    actionExecution,
    actionSubmitted: actionExecution.length,
    movementDecisions: [],
    movementExecution: [],
    movementSubmitted: 0,
    status: "executed",
  };
}

function snapshot(
  options: {
    readonly boostedWork?: number;
    readonly carried?: number;
    readonly sourceEnergy?: number;
    readonly spawnEnergy?: number;
  } = {},
): WorldSnapshot {
  const none = { active: 0, boosted: 0, total: 0 };
  const one = { active: 1, boosted: 0, total: 1 };
  const carried = options.carried ?? 10;
  const spawnEnergy = options.spawnEnergy ?? 100;
  const pos = (x: number) => ({ roomName: "W1N1", x, y: 10 });
  const value: WorldSnapshot = {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 100 },
    observedAt: 100,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: {
          id: "controller",
          level: 1,
          ownerUsername: "me",
          ownership: "owned",
          pos: pos(25),
          progress: 0,
          progressTotal: 200,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: 10_000,
          upgradeBlocked: null,
        },
        droppedResources: [{ amount: 3, id: "drop", pos: pos(9), resourceType: "energy" }],
        energyAvailable: spawnEnergy,
        energyCapacityAvailable: 300,
        hostileCreeps: [],
        name: "W1N1",
        observedAt: 100,
        ownedCreeps: [
          {
            body: {
              activeParts: 3,
              attack: none,
              carry: one,
              claim: none,
              heal: none,
              move: one,
              rangedAttack: none,
              size: 3,
              tough: none,
              work: { ...one, boosted: options.boostedWork ?? 0 },
            },
            fatigue: 0,
            hits: 300,
            hitsMax: 300,
            id: "worker",
            name: "worker",
            ownerUsername: "me",
            pos: pos(10),
            spawning: false,
            store: {
              capacity: 50,
              freeCapacity: 50 - carried,
              resources: carried === 0 ? [] : [{ amount: carried, resourceType: "energy" }],
              usedCapacity: carried,
            },
            ticksToLive: 1_000,
          },
        ],
        ownedExtensions: [],
        ownedSpawns: [
          {
            active: true,
            hits: 5_000,
            hitsMax: 5_000,
            id: "spawn",
            name: "Spawn1",
            pos: pos(11),
            spawning: null,
            store: {
              capacity: 300,
              freeCapacity: 300 - spawnEnergy,
              resources: spawnEnergy === 0 ? [] : [{ amount: spawnEnergy, resourceType: "energy" }],
              usedCapacity: spawnEnergy,
            },
          },
        ],
        ownedTowers: [],
        roads: [],
        sources: [
          {
            energy: options.sourceEnergy ?? 100,
            energyCapacity: 3_000,
            id: "source",
            pos: pos(12),
            ticksToRegeneration: null,
          },
        ],
        storedStructures: [],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 0,
        rooms: 1,
        sources: 1,
        storedStructures: 0,
        total: 5,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
  const room = value.rooms[0];
  if (room?.controller?.ownership !== "owned") throw new Error("expected owned-room fixture");
  return { ...value, ownedRooms: [room as WorldSnapshot["ownedRooms"][number]] };
}
