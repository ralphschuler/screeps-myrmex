import { describe, expect, it } from "vitest";
import { authorizedSurvivalFlow, planSurvivalFlow, renewSurvivalFlowBudgets } from "../src/economy";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

describe("survival flow", () => {
  it("selects the deterministic source or sink from the worker's carried energy", () => {
    const plan = planSurvivalFlow(snapshot());
    expect(plan.map(({ budgetRequest }) => budgetRequest.issuer)).toEqual([
      "economy/W1N1/worker-a/harvest/source-near",
    ]);
    expect(
      plan.every(
        ({ budgetRequest }) => budgetRequest.energy === null && budgetRequest.cpu?.minimum === 1,
      ),
    ).toBe(true);
    expect(planSurvivalFlow(snapshot(25)).map(({ budgetRequest }) => budgetRequest.issuer)).toEqual(
      ["economy/W1N1/worker-a/transfer/spawn-near"],
    );
  });

  it("funds suspended work again and cancels a vanished endpoint without duplicating its binding", () => {
    const candidates = planSurvivalFlow(snapshot());
    const harvest = candidates.find(({ action }) => action === "harvest");
    if (harvest === undefined) throw new Error("expected harvest candidate");
    const reservations = candidates.map(({ budgetRequest }) => ({
      ...budgetRequest,
      status: "active",
    }));
    const flow = authorizedSurvivalFlow(
      candidates,
      reservations,
      {
        status: "ready",
        contracts: [
          {
            budgetBinding: {
              category: "harvesting-filling",
              issuer: harvest.budgetRequest.issuer,
            },
            contractId: "harvest",
            execution: {
              action: "harvest",
              completion: "continuous",
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: harvest.budgetRequest.issuer,
            owner: { id: "W1N1", kind: "colony" },
            state: "suspended",
            targetId: "source-near",
          },
          {
            budgetBinding: {
              category: "harvesting-filling",
              issuer: "economy/W1N1/worker-a/harvest/old",
            },
            contractId: "old",
            execution: {
              action: "harvest",
              completion: "continuous",
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: "economy/W1N1/worker-a/harvest/old",
            owner: { id: "W1N1", kind: "colony" },
            state: "funded",
            targetId: "old",
          },
        ],
      },
      10,
    );
    expect(flow.requests).toHaveLength(1);
    expect(flow.transitions).toEqual([
      expect.objectContaining({ contractId: "harvest", to: "funded" }),
      expect.objectContaining({ contractId: "old", to: "cancelled" }),
    ]);
  });

  it("keeps a stable request until its bounded authorization is due for renewal", () => {
    const candidate = planSurvivalFlow(snapshot())[0];
    if (candidate === undefined) throw new Error("expected survival candidate");
    const current = {
      category: "harvesting-filling",
      colonyId: candidate.colonyId,
      issuer: candidate.budgetRequest.issuer,
      revision: 4,
      request: { ...candidate.budgetRequest, expiresAt: 20, revision: 4 },
      status: "active",
    };
    expect(
      renewSurvivalFlowBudgets([candidate], [current], 10, 12, 3)[0]?.budgetRequest,
    ).toMatchObject({ expiresAt: 20, revision: 4 });
    expect(
      renewSurvivalFlowBudgets([candidate], [current], 18, 12, 3)[0]?.budgetRequest,
    ).toMatchObject({ expiresAt: 30, revision: 5 });
  });

  it("caps local source or sink reservations at one worker per observed endpoint", () => {
    const single = snapshot();
    const room = single.rooms[0];
    const first = room?.ownedCreeps[0];
    const onlySource = room?.sources[0];
    if (room === undefined || first === undefined || onlySource === undefined)
      throw new Error("expected single-room fixture");
    const multi: WorldSnapshot = {
      ...single,
      rooms: [
        {
          ...room,
          ownedCreeps: [...room.ownedCreeps, { ...first, id: "worker-b", name: "worker-b" }],
          sources: [onlySource],
        },
      ],
    };
    expect(planSurvivalFlow(multi)).toHaveLength(1);
  });

  it("keeps continuous work suspended while an endpoint is unavailable, then re-funds it", () => {
    const transfer = planSurvivalFlow(snapshot(25))[0];
    if (transfer === undefined) throw new Error("expected transfer candidate");
    const planning = {
      status: "ready" as const,
      contracts: [
        {
          budgetBinding: { category: "harvesting-filling", issuer: transfer.budgetRequest.issuer },
          contractId: "fill",
          execution: {
            action: "transfer" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: "energy" as const,
            version: 1 as const,
          },
          issuer: transfer.budgetRequest.issuer,
          owner: { id: "W1N1", kind: "colony" as const },
          state: "suspended" as const,
          targetId: transfer.targetId,
        },
      ],
    };
    expect(authorizedSurvivalFlow([], [], planning, 20).transitions).toEqual([]);
    expect(
      authorizedSurvivalFlow(
        [transfer],
        [{ ...transfer.budgetRequest, status: "active" }],
        planning,
        21,
      ).transitions,
    ).toEqual([expect.objectContaining({ contractId: "fill", to: "funded" })]);
  });
});

function snapshot(carriedEnergy = 0): WorldSnapshot {
  const emptyStore = { capacity: 300, freeCapacity: 300, resources: [], usedCapacity: 0 };
  const workerStore = {
    capacity: 50,
    freeCapacity: 50 - carriedEnergy,
    resources: carriedEnergy === 0 ? [] : [{ amount: carriedEnergy, resourceType: "energy" }],
    usedCapacity: carriedEnergy,
  };
  const part = { active: 0, boosted: 0, total: 0 };
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    schemaVersion: 1,
    rooms: [
      {
        name: "W1N1",
        observedAt: 10,
        energyAvailable: 0,
        energyCapacityAvailable: 300,
        controller: {
          id: "controller",
          level: 1,
          ownerUsername: "me",
          ownership: "owned",
          pos: position(25, 25),
          progress: 0,
          progressTotal: 1,
          reservationTicksToEnd: null,
          reservationUsername: null,
          safeMode: null,
          safeModeAvailable: 0,
          safeModeCooldown: null,
          ticksToDowngrade: 1000,
          upgradeBlocked: null,
        },
        constructionSites: [],
        droppedResources: [],
        hostileCreeps: [],
        ownedCreeps: [
          {
            id: "worker-a",
            name: "worker",
            ownerUsername: "me",
            pos: position(10, 10),
            spawning: false,
            ticksToLive: 100,
            fatigue: 0,
            hits: 100,
            hitsMax: 100,
            store: workerStore,
            body: {
              activeParts: 3,
              attack: part,
              carry: { ...part, active: 1, total: 1 },
              claim: part,
              heal: part,
              move: { ...part, active: 1, total: 1 },
              rangedAttack: part,
              size: 3,
              tough: part,
              work: { ...part, active: 1, total: 1 },
            },
          },
        ],
        ownedExtensions: [],
        ownedSpawns: [
          {
            id: "spawn-near",
            name: "Spawn1",
            pos: position(11, 10),
            active: true,
            hits: 5000,
            hitsMax: 5000,
            spawning: null,
            store: emptyStore,
          },
        ],
        ownedTowers: [],
        ruins: [],
        sources: [
          {
            id: "source-far",
            pos: position(20, 20),
            energy: 3000,
            energyCapacity: 3000,
            ticksToRegeneration: null,
          },
          {
            id: "source-near",
            pos: position(11, 11),
            energy: 3000,
            energyCapacity: 3000,
            ticksToRegeneration: null,
          },
        ],
        storedStructures: [],
        tombstones: [],
      },
    ],
    ownedRooms: [],
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 1,
        ownedExtensions: 0,
        ownedSpawns: 1,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 2,
        storedStructures: 0,
        tombstones: 0,
        total: 5,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}
