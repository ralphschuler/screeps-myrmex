import { describe, expect, it } from "vitest";
import { authorizedSurvivalFlow, planSurvivalFlow, renewSurvivalFlowBudgets } from "../src/economy";
import {
  contractIdFor,
  normalizeContractRequest,
  requestSignature,
  WorkforceAllocator,
  workforceActorFromCreep,
  type ContractExecutionView,
  type ContractPlanningView,
  type WorkContractRecord,
} from "../src/contracts";
import type { WorldSnapshot } from "../src/world/snapshot";

const position = (x: number, y: number) => ({ roomName: "W1N1", x, y });

describe("survival flow", () => {
  it("batches partial cargo at a deterministic source before selecting a sink", () => {
    const plan = planSurvivalFlow(snapshot());
    expect(plan.map(({ budgetRequest }) => budgetRequest.issuer)).toEqual([
      "economy/W1N1/harvest/source-near",
    ]);
    expect(
      plan.every(
        ({ budgetRequest }) => budgetRequest.energy === null && budgetRequest.cpu?.minimum === 1,
      ),
    ).toBe(true);
    expect(planSurvivalFlow(snapshot(25)).map(({ budgetRequest }) => budgetRequest.issuer)).toEqual(
      ["economy/W1N1/harvest/source-near"],
    );
    expect(planSurvivalFlow(snapshot(50)).map(({ budgetRequest }) => budgetRequest.issuer)).toEqual(
      ["economy/W1N1/transfer/spawn-near"],
    );
    expect(
      planSurvivalFlow(snapshot(25, { sourceEnergy: 0 })).map(
        ({ budgetRequest }) => budgetRequest.issuer,
      ),
    ).toEqual(["economy/W1N1/transfer/spawn-near"]);
    expect(
      planSurvivalFlow(
        snapshot(25),
        activeFlowExecution("transfer"),
        activeFlowPlanning("transfer"),
      ).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/transfer/spawn-near"]);
    expect(
      planSurvivalFlow(
        snapshot(25),
        activeFlowExecution("harvest"),
        activeFlowPlanning("harvest"),
      ).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/harvest/source-near"]);
    expect(
      planSurvivalFlow(
        snapshot(25),
        activeFlowExecution("transfer"),
        activeFlowPlanning("transfer", false),
      ).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/harvest/source-near"]);

    const wrongBudget = activeFlowPlanning("transfer");
    const wrongBudgetContract = wrongBudget.contracts[0];
    if (wrongBudgetContract === undefined) throw new Error("expected active flow contract");
    expect(
      planSurvivalFlow(snapshot(25), activeFlowExecution("transfer"), {
        ...wrongBudget,
        contracts: [
          {
            ...wrongBudgetContract,
            budgetBinding: {
              ...wrongBudgetContract.budgetBinding,
              category: "optional-growth",
            },
          },
        ],
      }).map(({ budgetRequest }) => budgetRequest.issuer),
    ).toEqual(["economy/W1N1/harvest/source-near"]);
  });

  it("excludes full and inactive sinks while retaining a farther active sink", () => {
    expect(planSurvivalFlow(snapshot(50, { sinkFree: 0 }))).toEqual([]);
    expect(planSurvivalFlow(snapshot(50, { spawnActive: false }))).toEqual([]);

    const base = snapshot(50, { spawnActive: false });
    const room = base.rooms[0];
    const inactive = room?.ownedSpawns[0];
    if (room === undefined || inactive === undefined) throw new Error("expected spawn fixture");
    const withFarActive: WorldSnapshot = {
      ...base,
      rooms: [
        {
          ...room,
          ownedSpawns: [
            inactive,
            {
              ...inactive,
              active: true,
              id: "spawn-far",
              name: "Spawn2",
              pos: position(20, 20),
            },
          ],
        },
      ],
    };
    expect(planSurvivalFlow(withFarActive).map(({ targetId }) => targetId)).toEqual(["spawn-far"]);

    const withOnlyInactiveExtension: WorldSnapshot = {
      ...base,
      rooms: [
        {
          ...room,
          ownedExtensions: [{ ...inactive, id: "extension-inactive" }],
          ownedSpawns: [],
        },
      ],
    };
    expect(planSurvivalFlow(withOnlyInactiveExtension)).toEqual([]);
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
              issuer: "economy/W1N1/harvest/old",
            },
            contractId: "old",
            execution: {
              action: "harvest",
              completion: "continuous",
              counterpartId: null,
              resourceType: null,
              version: 1,
            },
            issuer: "economy/W1N1/harvest/old",
            owner: { id: "W1N1", kind: "colony" },
            state: "funded",
            targetId: "old",
          },
        ],
      },
      10,
      snapshot(),
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

  it("publishes endpoint demand that an eligible worker can take regardless of planner order", () => {
    const base = snapshot();
    const room = base.rooms[0];
    const template = room?.ownedCreeps[0];
    if (room === undefined || template === undefined) throw new Error("expected worker fixture");
    const carrier = {
      ...template,
      body: {
        ...template.body,
        activeParts: 2,
        size: 2,
        work: { active: 0, boosted: 0, total: 0 },
      },
      id: "carrier-a",
      name: "carrier-a",
    };
    const worker = { ...template, id: "worker-b", name: "worker-b" };
    const onlySource = room.sources.find(({ id }) => id === "source-near");
    if (onlySource === undefined) throw new Error("expected source fixture");
    const multi: WorldSnapshot = {
      ...base,
      rooms: [{ ...room, ownedCreeps: [carrier, worker], sources: [onlySource] }],
    };
    const candidate = planSurvivalFlow(multi)[0];
    if (candidate === undefined) throw new Error("expected endpoint demand");
    const flow = authorizedSurvivalFlow(
      [candidate],
      [{ ...candidate.budgetRequest, status: "active" }],
      { contracts: [], status: "ready" },
      10,
    );
    const request = flow.requests[0];
    if (request === undefined) throw new Error("expected work request");
    const normalized = normalizeContractRequest(request);
    const contract: WorkContractRecord = {
      ...normalized,
      history: [],
      id: contractIdFor(normalized.issuer, normalized.issuerKey, normalized.issuerSequence),
      lease: null,
      requestSignature: requestSignature(normalized),
      revision: 1,
      state: "funded",
    };
    const allocation = new WorkforceAllocator().allocate({
      actors: [workforceActorFromCreep(carrier), workforceActorFromCreep(worker)],
      contracts: [contract],
      tick: 10,
      travel: { estimate: () => 60 },
    });

    expect(candidate.actorId).toBe("carrier-a");
    expect(candidate.budgetRequest.issuer).toBe("economy/W1N1/harvest/source-near");
    expect(allocation.assignments).toEqual([
      expect.objectContaining({ actorId: "worker-b", assignmentCost: 60, contractId: contract.id }),
    ]);
  });

  it("keeps continuous work suspended while an endpoint is unavailable, then re-funds it", () => {
    const transfer = planSurvivalFlow(snapshot(50))[0];
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

  it("keeps endpoint demand reusable while a visible colony awaits a replacement worker", () => {
    const observed = snapshot();
    const room = observed.rooms[0];
    if (room === undefined) throw new Error("expected visible colony fixture");
    const withoutWorkers: WorldSnapshot = {
      ...observed,
      rooms: [{ ...room, ownedCreeps: [] }],
    };
    const planning = {
      status: "ready" as const,
      contracts: [
        {
          budgetBinding: {
            category: "harvesting-filling" as const,
            issuer: "economy/W1N1/harvest/source-near",
          },
          contractId: "dead-harvest",
          execution: {
            action: "harvest" as const,
            completion: "continuous" as const,
            counterpartId: null,
            resourceType: null,
            version: 1 as const,
          },
          issuer: "economy/W1N1/harvest/source-near",
          owner: { id: "W1N1", kind: "colony" as const },
          state: "funded" as const,
          targetId: "source-near",
        },
      ],
    };
    expect(authorizedSurvivalFlow([], [], planning, 20, withoutWorkers).transitions).toEqual([]);
  });
});

function activeFlowExecution(action: "harvest" | "transfer"): ContractExecutionView {
  const transfer = action === "transfer";
  return {
    status: "ready",
    leases: [
      {
        actorId: "worker-a",
        actorName: "worker",
        contractId: `contract-${action}`,
        deadline: 100,
        execution: {
          action,
          completion: "continuous",
          counterpartId: null,
          resourceType: transfer ? "energy" : null,
          version: 1,
        },
        expiresAt: 101,
        leaseExpiresAt: 101,
        priority: { class: "survival", value: 1_000 },
        quantity: 1,
        range: 1,
        revision: 1,
        state: "active",
        target: transfer ? position(11, 10) : position(11, 11),
        targetId: transfer ? "spawn-near" : "source-near",
      },
    ],
  };
}

function activeFlowPlanning(action: "harvest" | "transfer", economy = true): ContractPlanningView {
  const transfer = action === "transfer";
  const issuer = `${economy ? "economy" : "operation"}/W1N1/${action}/target`;
  return {
    status: "ready",
    contracts: [
      {
        budgetBinding: {
          category: economy ? "harvesting-filling" : "optional-growth",
          issuer,
        },
        contractId: `contract-${action}`,
        execution: {
          action,
          completion: "continuous",
          counterpartId: null,
          resourceType: transfer ? "energy" : null,
          version: 1,
        },
        issuer,
        owner: { id: "W1N1", kind: economy ? "colony" : "operation" },
        state: "active",
        targetId: transfer ? "spawn-near" : "source-near",
      },
    ],
  };
}

function snapshot(
  carriedEnergy = 0,
  options: {
    readonly sinkFree?: number;
    readonly sourceEnergy?: number;
    readonly spawnActive?: boolean;
  } = {},
): WorldSnapshot {
  const sinkFree = options.sinkFree ?? 300;
  const sinkEnergy = 300 - sinkFree;
  const emptyStore = {
    capacity: 300,
    freeCapacity: sinkFree,
    resources: sinkEnergy === 0 ? [] : [{ amount: sinkEnergy, resourceType: "energy" }],
    usedCapacity: sinkEnergy,
  };
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
    ownedConstructionSiteCount: 0,
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
            active: options.spawnActive ?? true,
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
            energy: options.sourceEnergy ?? 3000,
            energyCapacity: 3000,
            ticksToRegeneration: null,
          },
          {
            id: "source-near",
            pos: position(11, 11),
            energy: options.sourceEnergy ?? 3000,
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
