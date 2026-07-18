import { describe, expect, it } from "vitest";
import { planLeaseAgents } from "../src/agents";
import { emptyContractExecutionView, emptyContractPlanningView } from "../src/contracts";
import { layoutExtensionEvacuationBudgetIssuer } from "../src/layout";
import { projectLayoutExtensionEvacuations } from "../src/logistics/extension-evacuation";
import { observeLogisticsGraph, planLogisticsRuntime } from "../src/logistics/runtime";
import type { WorldSnapshot } from "../src/world/snapshot";

describe("logistics runtime adapter", () => {
  it("fails closed without contract prerequisites and suppresses optional sinks under pressure", () => {
    const snapshot = world();
    const unavailable = planLogisticsRuntime({
      execution: emptyContractExecutionView(),
      includeOptional: true,
      planning: emptyContractPlanningView(),
      snapshot,
      tick: 10,
    });
    expect(unavailable.contracts.commitments).toEqual([]);
    expect(unavailable.health).toEqual([{ colonyId: "W1N1", observedAt: 10, status: "failed" }]);

    const constrained = observeLogisticsGraph(snapshot, false);
    expect(constrained.nodes.some(({ id }) => id === "store:storage:sink:energy")).toBe(false);
    expect(constrained.nodes.some(({ id }) => id === "store:spawn:sink:energy")).toBe(true);
  });

  it("normalizes dropped, tombstone, ruin, and stored sources for one runtime graph", () => {
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
            ruins: [
              {
                id: "ruin-a",
                pos: { roomName: "W1N1", x: 8, y: 10 },
                store: {
                  capacity: null,
                  freeCapacity: null,
                  resources: [{ amount: 25, resourceType: "H" }],
                  usedCapacity: 25,
                },
              },
            ],
            tombstones: [
              {
                id: "tomb-a",
                pos: { roomName: "W1N1", x: 7, y: 10 },
                store: {
                  capacity: null,
                  freeCapacity: null,
                  resources: [{ amount: 30, resourceType: "energy" }],
                  usedCapacity: 30,
                },
              },
            ],
          },
        ],
      },
      true,
    );
    expect(graph.nodes.some(({ id }) => id.startsWith("drop:"))).toBe(true);
    expect(graph.nodes.some(({ id }) => id.startsWith("ruin:"))).toBe(true);
    expect(graph.nodes.some(({ id }) => id.startsWith("tombstone:"))).toBe(true);
    expect(graph.nodes.some(({ id }) => id.startsWith("store:container:source:"))).toBe(true);
  });

  it("leaves loose-resource recovery with bootstrap fallback until a dedicated hauler exists", () => {
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
            ownedCreeps: [],
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
    expect(result.health).toEqual([{ colonyId: "W1N1", observedAt: 10, status: "healthy" }]);
  });

  it("reports duplicate or capped graph evidence through direct room health", () => {
    const snapshot = world();
    const observed = observeLogisticsGraph(snapshot, true);
    const duplicate = observed.nodes[0];
    if (duplicate === undefined) throw new Error("logistics health fixture node missing");
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: {
        blockers: [],
        dispositions: [],
        edges: [],
        endpoints: [],
        nodes: [duplicate],
      },
      snapshot,
      tick: 10,
    });

    expect(result.plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "duplicate-id" })]),
    );
    expect(result.health).toEqual([{ colonyId: "W1N1", observedAt: 10, status: "failed" }]);
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

  it("composes externally funded lab demand without creating a second budget", () => {
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: {
        blockers: [],
        dispositions: [],
        edges: [
          {
            budgetBinding: { category: "industry", issuer: "industry/labs/U" },
            id: "lab-demand:u:r1:fill:U",
            maximumAmount: 100,
            roundTripTicks: 10,
            sinkNodeId: "lab:W1N1:lab-a:mineral:U",
            sourceNodeId: "inventory:W1N1:storage:U",
          },
        ],
        endpoints: [
          {
            acquireAction: "withdraw",
            freeCapacity: 0,
            nodeId: "inventory:W1N1:storage:U",
            observedAmount: 100,
            observedAt: 10,
            position: position(15, 15),
            resourceType: "U",
            targetId: "storage",
          },
          {
            freeCapacity: 3_000,
            nodeId: "lab:W1N1:lab-a:mineral:U",
            observedAmount: 0,
            observedAt: 10,
            position: position(14, 15),
            resourceType: "U",
            targetId: "lab-a",
          },
        ],
        nodes: [
          {
            colonyId: "W1N1",
            freeCapacity: 0,
            id: "inventory:W1N1:storage:U",
            kind: "source",
            observedAmount: 100,
            observedAt: 10,
            position: position(15, 15),
            priority: { class: "normal", deadline: 50 },
            resourceType: "U",
          },
          {
            capacityReservationKey: "lab:W1N1:lab-a:mineral-capacity",
            colonyId: "W1N1",
            freeCapacity: 3_000,
            id: "lab:W1N1:lab-a:mineral:U",
            kind: "sink",
            observedAmount: 0,
            observedAt: 10,
            position: position(14, 15),
            priority: { class: "normal", deadline: 50 },
            resourceType: "U",
          },
        ],
      },
      snapshot: world(),
      tick: 10,
    });

    const lab = result.contracts.commitments.find(({ flowId }) => flowId.startsWith("lab-demand:"));
    expect(lab?.request?.budgetBinding).toEqual({
      category: "industry",
      issuer: "industry/labs/U",
    });
    expect(result.budgets.some(({ category }) => category === "industry")).toBe(false);
  });

  it("routes one persisted obsolete-extension evacuation without refilling its source", () => {
    const snapshot = world();
    const room = snapshot.rooms[0];
    if (room === undefined) throw new Error("extension evacuation fixture room missing");
    const extension = (id: string, x: number, used: number) => ({
      active: true,
      hits: 1_000,
      hitsMax: 1_000,
      id,
      pos: position(x, 12),
      store: {
        capacity: 50,
        freeCapacity: 50 - used,
        resources: used === 0 ? [] : [{ amount: used, resourceType: "energy" }],
        usedCapacity: used,
      },
    });
    const evacuationWorld = {
      ...snapshot,
      rooms: [
        {
          ...room,
          ownedExtensions: [
            extension("extension-obsolete", 11, 40),
            extension("extension-replacement", 12, 0),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const evacuationTerms = {
      amount: 40,
      expiresAt: 160,
      replacementId: "extension-replacement",
      replacementInitialEnergy: 0,
      sourceId: "extension-obsolete",
      startedAt: 10,
    } as const;
    const budgetIssuer = layoutExtensionEvacuationBudgetIssuer("W1N1", evacuationTerms);
    if (budgetIssuer === null) throw new Error("extension evacuation budget issuer overflowed");
    const evacuation = projectLayoutExtensionEvacuations({
      existingBudgets: [],
      records: [
        {
          algorithmRevision: "owned-room-layout-v2-source-services",
          anchor: position(25, 25),
          blockers: [],
          committedAt: 1,
          extensionEvacuation: evacuationTerms,
          fingerprint: "layout-a",
          roomName: "W1N1",
          transform: 0,
        },
      ],
      snapshot: evacuationWorld,
      tick: 10,
    });
    const result = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: evacuation.demands,
      snapshot: evacuationWorld,
      tick: 10,
    });
    const flow = result.contracts.commitments.find(({ flowId }) =>
      flowId.startsWith("layout-extension-evacuation:"),
    );

    expect(evacuation.budgets).toEqual([
      expect.objectContaining({
        category: "optional-growth",
        issuer: budgetIssuer,
      }),
    ]);
    expect(result.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:extension-obsolete:sink:energy" }),
    );
    expect(flow?.request).toMatchObject({
      budgetBinding: {
        category: "optional-growth",
        issuer: budgetIssuer,
      },
      execution: {
        action: "withdraw",
        counterpartId: "extension-replacement",
      },
      quantity: 40,
      targetId: "extension-obsolete",
    });
    expect(result.budgets.some(({ issuer }) => issuer === budgetIssuer)).toBe(false);

    const emptiedWorld = {
      ...evacuationWorld,
      rooms: [
        {
          ...room,
          ownedExtensions: [
            extension("extension-obsolete", 11, 0),
            extension("extension-replacement", 12, 0),
          ],
        },
      ],
    } satisfies WorldSnapshot;
    const emptied = projectLayoutExtensionEvacuations({
      existingBudgets: [],
      records: [
        {
          algorithmRevision: "owned-room-layout-v2-source-services",
          anchor: position(25, 25),
          blockers: [],
          committedAt: 1,
          extensionEvacuation: evacuationTerms,
          fingerprint: "layout-a",
          roomName: "W1N1",
          transform: 0,
        },
      ],
      snapshot: emptiedWorld,
      tick: 10,
    });
    const emptiedResult = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: emptied.demands,
      snapshot: emptiedWorld,
      tick: 10,
    });
    expect(emptiedResult.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: "store:extension-obsolete:sink:energy" }),
    );
    expect(emptiedResult.graph.nodes).toContainEqual(
      expect.objectContaining({ id: "store:extension-replacement:sink:energy" }),
    );
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
