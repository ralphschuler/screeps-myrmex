import { describe, expect, it } from "vitest";
import { planLeaseAgents } from "../src/agents";
import { emptyContractExecutionView, emptyContractPlanningView } from "../src/contracts";
import { observeLogisticsGraph, planLogisticsRuntime } from "../src/logistics/runtime";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("logistics runtime adapter", () => {
  it("fails closed without contract prerequisites and suppresses optional sinks under pressure", () => {
    const snapshot = world();
    expect(
      planLogisticsRuntime({
        execution: emptyContractExecutionView(),
        includeOptional: true,
        planning: emptyContractPlanningView(),
        snapshot,
        tick: 10,
      }).contracts.commitments,
    ).toEqual([]);

    const constrained = observeLogisticsGraph(snapshot, false);
    expect(constrained.nodes.some(({ id }) => id === "store:storage:sink:energy")).toBe(false);
    expect(constrained.nodes.some(({ id }) => id === "store:spawn:sink:energy")).toBe(true);
  });

  it("leaves dropped energy with the established fallback while observing stored sources", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new TypeError("logistics fixture room is missing");
    const graph = observeLogisticsGraph(
      {
        ...snapshot,
        rooms: [
          {
            ...room,
            droppedResources: [
              {
                amount: 50,
                id: "drop-a",
                pos: { roomName: "W1N1", x: 9, y: 10 },
                resourceType: "energy",
              },
            ],
          },
        ],
      },
      true,
    );
    expect(graph.nodes.some(({ id }) => id.startsWith("drop:"))).toBe(false);
    expect(graph.nodes.some(({ id }) => id.startsWith("store:container:source:"))).toBe(true);
  });

  it("projects one mandatory reservation-backed haul without duplicate flow identities", () => {
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      snapshot: world(),
      tick: 10,
    });
    const active = result.contracts.commitments.filter(({ request }) => request !== null);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ priorityClass: "mandatory", stage: "acquire" });
    expect(active[0]?.request).toMatchObject({
      execution: { action: "withdraw", stage: "acquire", version: 3 },
      kind: "haul",
      quantity: 200,
    });
    expect(result.budgets).toEqual([
      expect.objectContaining({
        category: "harvesting-filling",
        cpu: { minimum: 100, desired: 100 },
        energy: null,
      }),
    ]);
    expect(new Set(active.map(({ flowId }) => flowId)).size).toBe(active.length);
  });

  it("retains operational funding while constrained planning preempts optional reserve use", () => {
    const normal = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      snapshot: world(0, 250),
      tick: 10,
    });
    expect(normal.budgets.map(({ category }) => category).sort()).toEqual([
      "harvesting-filling",
      "optional-growth",
    ]);
    expect(normal.budgets.every(({ energy }) => energy === null)).toBe(true);
    expect(
      normal.budgets.find(({ category }) => category === "harvesting-filling")?.cpu?.minimum,
    ).toBe(100);

    const constrained = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      snapshot: world(0, 250),
      tick: 10,
    });
    expect(constrained.budgets.map(({ category }) => category)).toEqual(["harvesting-filling"]);
  });

  it("clamps V3 acquire and partial delivery to observed exact quantities", () => {
    const acquire = planLeaseAgents({
      availablePathCpu: 1,
      execution: execution("acquire", 40),
      paths: { plan: () => ({ status: "unavailable" }) } as never,
      snapshot: world(0),
      tick: 10,
    });
    expect(acquire.actions[0]).toMatchObject({ amount: 40, kind: "withdraw" });

    const deliver = planLeaseAgents({
      availablePathCpu: 1,
      execution: execution("deliver", 50),
      paths: { plan: () => ({ status: "unavailable" }) } as never,
      snapshot: world(30),
      tick: 10,
    });
    expect(deliver.actions[0]).toMatchObject({ amount: 30, kind: "transfer" });
  });
});

function execution(stage: "acquire" | "deliver", quantity: number) {
  return {
    status: "ready" as const,
    leases: [
      {
        actorId: "hauler",
        actorName: "hauler",
        contractId: `contract:${stage}`,
        deadline: 50,
        execution: {
          action: stage === "acquire" ? ("withdraw" as const) : ("transfer" as const),
          completion: stage === "acquire" ? ("target-depleted" as const) : ("target-full" as const),
          counterpartId: stage === "acquire" ? "spawn" : "container",
          flowId: "flow:container-spawn",
          recommendedCarry: 1,
          recommendedMove: 1,
          reservedAmount: quantity,
          resourceType: "energy" as ResourceConstant,
          stage,
          version: 3 as const,
        },
        expiresAt: 51,
        leaseExpiresAt: 20,
        priority: { class: "survival" as const, value: 850 },
        quantity,
        range: 1,
        revision: 1,
        state: "assigned" as const,
        target: stage === "acquire" ? position(10, 11) : position(11, 10),
        targetId: stage === "acquire" ? "container" : "spawn",
      },
    ],
  };
}

function world(cargo = 0, spawnEnergy = 0): WorldSnapshot {
  const part = { active: 0, boosted: 0, total: 0 };
  const store = (capacity: number, energy: number) => ({
    capacity,
    freeCapacity: capacity - energy,
    resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
    usedCapacity: energy,
  });
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick: 10 },
    observedAt: 10,
    ownedConstructionSiteCount: 0,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: {
          id: "controller",
          level: 2,
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
          ticksToDowngrade: 10_000,
          upgradeBlocked: null,
        },
        droppedResources: [],
        energyAvailable: 0,
        energyCapacityAvailable: 300,
        hostileCreeps: [],
        name: "W1N1",
        observedAt: 10,
        ownedExtensions: [],
        ownedTowers: [],
        ruins: [],
        sources: [],
        tombstones: [],
        ownedCreeps: [
          {
            body: {
              activeParts: 2,
              attack: part,
              carry: { ...part, active: 1, total: 1 },
              claim: part,
              heal: part,
              move: { ...part, active: 1, total: 1 },
              rangedAttack: part,
              size: 2,
              tough: part,
              work: part,
            },
            fatigue: 0,
            hits: 100,
            hitsMax: 100,
            id: "hauler",
            name: "hauler",
            ownerUsername: "me",
            pos: position(10, 10),
            spawning: false,
            store: store(50, cargo),
            ticksToLive: 100,
          },
        ],
        ownedSpawns: [
          {
            active: true,
            hits: 5000,
            hitsMax: 5000,
            id: "spawn",
            name: "Spawn1",
            pos: position(11, 10),
            spawning: null,
            store: store(300, spawnEnergy),
          },
        ],
        storedStructures: [
          {
            hits: 250000,
            hitsMax: 250000,
            id: "container",
            ownerUsername: null,
            ownership: "unowned",
            pos: position(10, 11),
            store: store(2000, 200),
            structureType: "container",
            ticksToDecay: 5000,
          },
          {
            hits: 10000,
            hitsMax: 10000,
            id: "storage",
            ownerUsername: "me",
            ownership: "owned",
            pos: position(15, 15),
            store: store(1000000, 300),
            structureType: "storage",
            ticksToDecay: null,
          },
        ],
      },
    ],
    schemaVersion: 1,
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
        sources: 0,
        storedStructures: 2,
        tombstones: 0,
        total: 5,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  };
}

function position(x: number, y: number) {
  return { roomName: "W1N1", x, y };
}
