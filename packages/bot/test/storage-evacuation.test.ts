import { describe, expect, it } from "vitest";
import {
  emptyContractExecutionView,
  emptyContractPlanningView,
  type ContractExecutionView,
} from "../src/contracts";
import {
  LAYOUT_ALGORITHM_REVISION,
  emptyLayoutsOwner,
  layoutStorageEvacuationBudgetIssuer,
  layoutStorageEvacuationFlowId,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutStorageEvacuation,
  type LayoutRecord,
  type LayoutStorageEvacuation,
} from "../src/layout";
import { aggregateStoreCapacityReservationKey } from "../src/logistics/planner";
import { planLogisticsRuntime } from "../src/logistics/runtime";
import { projectLayoutStorageEvacuations } from "../src/logistics/storage-evacuation";
import {
  isAuthorizedLayoutStorageEvacuationFlowId,
  projectLayoutTerminalSendBlockedRoomNames,
  withoutSuppressedLeaseTargets,
  withoutSuppressedResourceDemandTargets,
} from "../src/runtime/tick";
import type { WorldSnapshot } from "../src/world/snapshot";

const roomName = "W1N1";
const sourceId = "storage-obsolete";
const terminalId = "terminal-active";
const commitment = {
  algorithmRevision: LAYOUT_ALGORITHM_REVISION,
  anchor: { roomName, x: 25, y: 25 },
  blockers: [],
  committedAt: 10,
  fingerprint: "layout-storage-a",
  transform: 0,
} as const;
const terms = {
  amount: 3_000,
  expiresAt: 160,
  resourceType: "energy",
  sourceId,
  startedAt: 10,
  terminalId,
  terminalInitialAmount: 25_000,
} as const satisfies LayoutStorageEvacuation;

function inventory(capacity: number, resources: readonly (readonly [string, number])[]) {
  const usedCapacity = resources.reduce((total, [, amount]) => total + amount, 0);
  return {
    capacity,
    freeCapacity: capacity - usedCapacity,
    resources: resources.map(([resourceType, amount]) => ({ amount, resourceType })),
    usedCapacity,
  };
}

function world(
  sourceResources: readonly (readonly [string, number])[] = [[terms.resourceType, terms.amount]],
  terminalResources: readonly (readonly [string, number])[] = [
    [terms.resourceType, terms.terminalInitialAmount],
  ],
  tick = 11,
): WorldSnapshot {
  return {
    observation: { age: 0, shard: "shard0", status: "observed", tick },
    observedAt: tick,
    ownedConstructionSiteCount: 0,
    ownedRooms: [],
    rooms: [
      {
        constructionSites: [],
        controller: { level: 8, ownership: "owned" },
        hostileCreeps: [],
        name: roomName,
        observedAt: tick,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns: [],
        ownedStorages: [
          {
            active: true,
            hits: 10_000,
            hitsMax: 10_000,
            id: sourceId,
            pos: { roomName, x: 30, y: 30 },
            store: inventory(1_000_000, sourceResources),
          },
        ],
        ownedTerminals: [
          {
            active: true,
            cooldown: 0,
            hits: 3_000,
            hitsMax: 3_000,
            id: terminalId,
            pos: { roomName, x: 21, y: 20 },
            store: inventory(300_000, terminalResources),
          },
        ],
        ownedTowers: [],
        sources: [],
        storedStructures: [],
      },
    ],
    schemaVersion: 1,
    stats: {
      entities: {
        constructionSites: 0,
        controllers: 1,
        droppedResources: 0,
        hostileCreeps: 0,
        ownedCreeps: 0,
        ownedExtensions: 0,
        ownedSpawns: 0,
        ownedTowers: 0,
        rooms: 1,
        ruins: 0,
        sources: 0,
        storedStructures: 0,
        tombstones: 0,
        total: 3,
      },
      estimatedPayloadBytes: 1,
    },
    visibility: { absentRoomSemantics: "unknown", rooms: [], scope: "current-tick" },
  } as unknown as WorldSnapshot;
}

function record(evacuation: LayoutStorageEvacuation = terms): LayoutRecord {
  return { ...commitment, roomName, storageEvacuation: evacuation };
}

function project(
  snapshot = world(),
  tick = snapshot.observedAt,
  records: readonly LayoutRecord[] = [record()],
) {
  return projectLayoutStorageEvacuations({
    existingBudgets: [],
    quiescentTerminalRoomNames: new Set([roomName]),
    records,
    snapshot,
    tick,
  });
}

describe("single-resource stocked-storage evacuation", () => {
  it("persists V21 terms while V20 migration invents none and rejects spoofed terms", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    const v20 = { ...owner, schemaVersion: 20 } as const;
    expect(parseLayoutsOwner(v20)).toEqual({ ...owner, revision: owner.revision + 1 });
    expect(
      parseLayoutsOwner({
        ...v20,
        records: [{ ...v20.records[0], storageEvacuation: terms }],
      }),
    ).toBeNull();

    owner = persistLayoutStorageEvacuation(owner, roomName, terms);
    expect(owner.schemaVersion).toBe(21);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(
      persistLayoutCommitment(owner, roomName, commitment).records[0]?.storageEvacuation,
    ).toEqual(terms);
    expect(
      persistLayoutCommitment(owner, roomName, { ...commitment, fingerprint: "layout-storage-b" })
        .records[0]?.storageEvacuation,
    ).toBeUndefined();
    expect(
      persistLayoutStorageEvacuation(owner, roomName, null).records[0]?.storageEvacuation,
    ).toBeUndefined();

    for (const malformed of [
      { ...terms, amount: 0 },
      { ...terms, amount: 3_001 },
      { ...terms, expiresAt: 159 },
      { ...terms, resourceType: " energy" },
      { ...terms, sourceId: terminalId },
      { ...terms, terminalInitialAmount: 297_001 },
      { ...terms, terminalInitialAmount: -1 },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], storageEvacuation: malformed }],
        }),
      ).toBeNull();
  });

  it("preserves a future owner byte-for-byte and authorizes no layout work", () => {
    const futureOwner = {
      ...persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment),
      schemaVersion: 22,
    };
    const before = JSON.stringify(futureOwner);
    const parsed = parseLayoutsOwner(futureOwner);

    expect(parsed).toBeNull();
    expect(JSON.stringify(futureOwner)).toBe(before);
    expect(project(world(), 11, parsed?.records ?? [])).toEqual({
      budgets: [],
      demands: {
        edges: [],
        endpoints: [],
        nodes: [],
        suppressedSinkTargetIds: [],
        suppressedSourceTargetIds: [],
      },
    });
  });

  it("projects one next-tick funded V3 flow with aggregate terminal capacity and four-way suppression", () => {
    const issuer = layoutStorageEvacuationBudgetIssuer(roomName, terms);
    const flowId = layoutStorageEvacuationFlowId(roomName, terms);
    if (issuer === null || flowId === null) throw new Error("expected bounded storage identity");

    const projection = project();
    expect(projection.budgets).toEqual([
      expect.objectContaining({ category: "optional-growth", issuer }),
    ]);
    expect(projection.demands.edges).toEqual([
      expect.objectContaining({
        budgetBinding: { category: "optional-growth", issuer },
        id: flowId,
        maximumAmount: terms.amount,
      }),
    ]);
    expect(projection.demands.endpoints).toEqual([
      expect.objectContaining({ acquireAction: "withdraw", targetId: sourceId }),
      expect.objectContaining({ targetId: terminalId }),
    ]);
    expect(projection.demands.nodes).toContainEqual(
      expect.objectContaining({
        capacityReservationKey: aggregateStoreCapacityReservationKey(roomName, terminalId),
        resourceType: terms.resourceType,
      }),
    );
    expect(projection.demands.suppressedSinkTargetIds).toEqual([sourceId, terminalId]);
    expect(projection.demands.suppressedSourceTargetIds).toEqual([sourceId, terminalId]);

    const logistics = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: projection.demands,
      snapshot: world(),
      tick: 11,
    });
    expect(
      logistics.contracts.commitments.find((candidate) => candidate.flowId === flowId)?.request,
    ).toMatchObject({
      budgetBinding: { category: "optional-growth", issuer },
      execution: {
        action: "withdraw",
        counterpartId: terminalId,
        resourceType: terms.resourceType,
        version: 3,
      },
      quantity: terms.amount,
      targetId: sourceId,
    });
  });

  it("rejects orphan-prefixed flows and removes competing custom demands at both endpoints", () => {
    const flowId = layoutStorageEvacuationFlowId(roomName, terms);
    if (flowId === null) throw new Error("expected bounded storage identity");
    expect(isAuthorizedLayoutStorageEvacuationFlowId(flowId, new Set(), new Set())).toBe(false);
    expect(isAuthorizedLayoutStorageEvacuationFlowId(flowId, new Set([flowId]), new Set())).toBe(
      false,
    );
    expect(
      isAuthorizedLayoutStorageEvacuationFlowId(flowId, new Set([flowId]), new Set([flowId])),
    ).toBe(true);
    expect(isAuthorizedLayoutStorageEvacuationFlowId("ordinary-flow", new Set(), new Set())).toBe(
      true,
    );

    const evacuation = project().demands;
    const competingNodes = [
      {
        colonyId: roomName,
        freeCapacity: 0,
        id: "competing-storage-source",
        kind: "source" as const,
        observedAmount: 1,
        observedAt: 11,
        position: { roomName, x: 30, y: 30 },
        priority: { class: "normal" as const, deadline: 20 },
        resourceType: terms.resourceType,
      },
      {
        colonyId: roomName,
        freeCapacity: 100,
        id: "competing-sink",
        kind: "sink" as const,
        observedAmount: 0,
        observedAt: 11,
        position: { roomName, x: 20, y: 20 },
        priority: { class: "normal" as const, deadline: 20 },
        resourceType: terms.resourceType,
      },
      {
        colonyId: roomName,
        freeCapacity: 0,
        id: "competing-source",
        kind: "source" as const,
        observedAmount: 1,
        observedAt: 11,
        position: { roomName, x: 20, y: 20 },
        priority: { class: "normal" as const, deadline: 20 },
        resourceType: terms.resourceType,
      },
      {
        colonyId: roomName,
        freeCapacity: 100,
        id: "competing-terminal-sink",
        kind: "sink" as const,
        observedAmount: 0,
        observedAt: 11,
        position: { roomName, x: 21, y: 20 },
        priority: { class: "normal" as const, deadline: 20 },
        resourceType: terms.resourceType,
      },
    ];
    const filtered = withoutSuppressedResourceDemandTargets(
      {
        ...evacuation,
        edges: [
          ...evacuation.edges,
          {
            id: "competing-storage-flow",
            maximumAmount: 1,
            roundTripTicks: 1,
            sinkNodeId: "competing-sink",
            sourceNodeId: "competing-storage-source",
          },
          {
            id: "competing-terminal-flow",
            maximumAmount: 1,
            roundTripTicks: 1,
            sinkNodeId: "competing-terminal-sink",
            sourceNodeId: "competing-source",
          },
        ],
        endpoints: [
          ...evacuation.endpoints,
          {
            nodeId: "competing-storage-source",
            freeCapacity: 0,
            observedAmount: 1,
            observedAt: 11,
            position: { roomName, x: 30, y: 30 },
            resourceType: terms.resourceType,
            targetId: sourceId,
          },
          {
            nodeId: "competing-sink",
            freeCapacity: 100,
            observedAmount: 0,
            observedAt: 11,
            position: { roomName, x: 20, y: 20 },
            resourceType: terms.resourceType,
            targetId: "other-sink",
          },
          {
            nodeId: "competing-source",
            freeCapacity: 0,
            observedAmount: 1,
            observedAt: 11,
            position: { roomName, x: 20, y: 20 },
            resourceType: terms.resourceType,
            targetId: "other-source",
          },
          {
            nodeId: "competing-terminal-sink",
            freeCapacity: 100,
            observedAmount: 0,
            observedAt: 11,
            position: { roomName, x: 21, y: 20 },
            resourceType: terms.resourceType,
            targetId: terminalId,
          },
        ],
        nodes: [...evacuation.nodes, ...competingNodes],
      },
      new Set([sourceId, terminalId]),
      new Set([flowId]),
    );
    expect(filtered.edges.map(({ id }) => id)).toEqual([flowId]);
    expect(filtered.endpoints).toHaveLength(2);
    expect(filtered.nodes).toHaveLength(2);
  });

  it("resumes partial delivery deterministically after JSON reset and structure/resource reordering", () => {
    const snapshot = world(
      [[terms.resourceType, 1_500]],
      [
        ["H", 500],
        [terms.resourceType, 26_500],
      ],
      12,
    );
    const observedRoom = snapshot.rooms[0];
    if (observedRoom === undefined) throw new Error("expected storage room");
    const reordered = {
      ...snapshot,
      rooms: [
        {
          ...observedRoom,
          ownedStorages: [...(observedRoom.ownedStorages ?? [])].reverse().map((storage) => ({
            ...storage,
            store: { ...storage.store, resources: [...storage.store.resources].reverse() },
          })),
          ownedTerminals: [...(observedRoom.ownedTerminals ?? [])].reverse().map((terminal) => ({
            ...terminal,
            store: { ...terminal.store, resources: [...terminal.store.resources].reverse() },
          })),
        },
      ],
    } as WorldSnapshot;
    const priorBudget = project().budgets.map((budget) => ({ ...budget, status: "active" }));
    const resumed = projectLayoutStorageEvacuations({
      existingBudgets: priorBudget,
      quiescentTerminalRoomNames: new Set([roomName]),
      records: JSON.parse(JSON.stringify([record()])) as LayoutRecord[],
      snapshot: reordered,
      tick: 12,
    });
    expect(resumed.demands.edges).toHaveLength(1);
    expect(resumed.demands.endpoints[0]).toMatchObject({
      observedAmount: 1_500,
      targetId: sourceId,
    });
    expect(resumed.demands.suppressedSinkTargetIds).toEqual([sourceId, terminalId]);
  });

  it("retains exact completion evidence until the Logistics contract retires", () => {
    const flowId = layoutStorageEvacuationFlowId(roomName, terms);
    const issuer = layoutStorageEvacuationBudgetIssuer(roomName, terms);
    if (flowId === null || issuer === null) throw new Error("expected bounded storage identity");
    const completed = project(world([], [[terms.resourceType, 28_000]], 12), 12);
    expect(completed.demands.edges).toHaveLength(1);
    const runtime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: {
        contracts: [
          {
            budgetBinding: { category: "optional-growth", issuer },
            contractId: "storage-deliver-contract",
            execution: {
              action: "transfer",
              completion: "target-full",
              counterpartId: sourceId,
              flowId,
              recommendedCarry: 1,
              recommendedMove: 1,
              reservedAmount: terms.amount,
              resourceType: terms.resourceType as ResourceConstant,
              stage: "deliver",
              version: 3,
            },
            issuer: "logistics/storage-evacuation",
            owner: { id: roomName, kind: "colony" },
            state: "active",
            targetId: terminalId,
          },
        ],
        status: "ready",
      },
      resourceDemands: completed.demands,
      snapshot: world([], [[terms.resourceType, 28_000]], 12),
      tick: 12,
    });
    expect(runtime.contracts.retirements).toContainEqual(
      expect.objectContaining({ reason: "logistics-flow-complete", to: "completed" }),
    );

    expect(project(world([], [[terms.resourceType, 27_999]], 12), 12).demands.edges).toHaveLength(
      1,
    );
    for (const snapshot of [
      world([], [[terms.resourceType, 28_001]], 12),
      world([[terms.resourceType, 1]], [[terms.resourceType, 28_000]], 12),
    ])
      expect(project(snapshot, 12).demands.edges).toEqual([]);
  });

  it("retains durable suppression through threat, drift, and optional-flow overflow but releases it at expiry", () => {
    for (const projection of [
      projectLayoutStorageEvacuations({
        existingBudgets: [],
        includeWork: false,
        quiescentTerminalRoomNames: new Set(),
        records: [record()],
        snapshot: world(),
        tick: 11,
      }),
      projectLayoutStorageEvacuations({
        existingBudgets: [],
        quiescentTerminalRoomNames: new Set(),
        records: [record()],
        snapshot: world(),
        tick: 11,
      }),
    ])
      expect(projection).toMatchObject({
        budgets: [],
        demands: {
          edges: [],
          suppressedSinkTargetIds: [sourceId, terminalId],
          suppressedSourceTargetIds: [sourceId, terminalId],
        },
      });

    const threatened = world();
    const observedRoom = threatened.rooms[0];
    if (observedRoom === undefined) throw new Error("expected storage room");
    const drifted = {
      ...threatened,
      rooms: [{ ...observedRoom, hostileCreeps: [{ id: "hostile" }] }],
    } as unknown as WorldSnapshot;
    expect(project(drifted).demands).toMatchObject({
      edges: [],
      suppressedSinkTargetIds: [sourceId, terminalId],
      suppressedSourceTargetIds: [sourceId, terminalId],
    });

    const source = observedRoom.ownedStorages?.[0];
    const terminal = observedRoom.ownedTerminals?.[0];
    if (source === undefined || terminal === undefined)
      throw new Error("expected migration endpoints");
    const overflowRuntime = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: true,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: {
        edges: [],
        endpoints: [],
        nodes: Array.from({ length: 129 }, (_, index) => ({
          colonyId: roomName,
          freeCapacity: 0,
          id: `optional-overflow-${String(index)}`,
          kind: "source" as const,
          observedAmount: 1,
          observedAt: 11,
          position: { roomName, x: 10, y: 10 },
          priority: { class: "normal" as const, deadline: 159 },
          resourceType: terms.resourceType,
        })),
        suppressedSinkTargetIds: [sourceId, terminalId],
        suppressedSourceTargetIds: [sourceId, terminalId],
      },
      snapshot: {
        ...threatened,
        rooms: [
          {
            ...observedRoom,
            storedStructures: [
              {
                ...source,
                ownerUsername: "me",
                ownership: "owned",
                structureType: "storage",
              },
              {
                ...terminal,
                ownerUsername: "me",
                ownership: "owned",
                structureType: "terminal",
              },
            ],
          },
        ],
      },
      tick: 11,
    });
    expect(overflowRuntime.graph.nodes.some(({ id }) => id.includes(`store:${sourceId}:`))).toBe(
      false,
    );
    expect(overflowRuntime.graph.nodes.some(({ id }) => id.includes(`store:${terminalId}:`))).toBe(
      false,
    );

    const baseRoom = world().rooms[0];
    if (baseRoom === undefined) throw new Error("expected overflow room");
    const records: LayoutRecord[] = [];
    const rooms: WorldSnapshot["rooms"][number][] = [];
    for (let index = 0; index < 65; index += 1) {
      const currentRoom = `W${String(index)}N1`;
      const currentSource = `${sourceId}-${String(index)}`;
      const currentTerminal = `${terminalId}-${String(index)}`;
      records.push({
        ...commitment,
        anchor: { ...commitment.anchor, roomName: currentRoom },
        roomName: currentRoom,
        storageEvacuation: {
          ...terms,
          sourceId: currentSource,
          terminalId: currentTerminal,
        },
      });
      rooms.push({
        ...baseRoom,
        name: currentRoom,
        ownedStorages: (baseRoom.ownedStorages ?? []).map((storage) => ({
          ...storage,
          id: currentSource,
          pos: { ...storage.pos, roomName: currentRoom },
        })),
        ownedTerminals: (baseRoom.ownedTerminals ?? []).map((terminal) => ({
          ...terminal,
          id: currentTerminal,
          pos: { ...terminal.pos, roomName: currentRoom },
        })),
      });
    }
    const overflow = projectLayoutStorageEvacuations({
      existingBudgets: [],
      quiescentTerminalRoomNames: new Set(rooms.map(({ name }) => name)),
      records,
      snapshot: { ...world(), rooms },
      tick: 11,
    });
    expect(overflow.demands.edges).toEqual([]);

    expect(
      project(
        world([[terms.resourceType, terms.amount]], undefined, terms.expiresAt),
        terms.expiresAt,
      ).demands.suppressedSourceTargetIds,
    ).toEqual([]);
  });

  it("blocks internal sends and filters every stale lease naming either endpoint", () => {
    expect(projectLayoutTerminalSendBlockedRoomNames([record()], 11)).toEqual(new Set([roomName]));
    expect(projectLayoutTerminalSendBlockedRoomNames([record()], terms.expiresAt)).toEqual(
      new Set(),
    );
    const flowId = layoutStorageEvacuationFlowId(roomName, terms);
    if (flowId === null) throw new Error("expected bounded storage identity");
    const execution = {
      leases: [
        {
          actorId: "exact-hauler",
          execution: { counterpartId: terminalId, flowId, version: 3 },
          targetId: sourceId,
        },
        {
          actorId: "stale-source-hauler",
          execution: { counterpartId: terminalId, flowId: "stale", version: 3 },
          targetId: sourceId,
        },
        {
          actorId: "stale-terminal-hauler",
          execution: { counterpartId: "other", flowId: "other", version: 3 },
          targetId: terminalId,
        },
        {
          actorId: "safe-worker",
          execution: { counterpartId: null, flowId: "safe", version: 1 },
          targetId: "safe-source",
        },
      ],
      status: "ready",
    } as unknown as ContractExecutionView;
    expect(
      withoutSuppressedLeaseTargets(
        execution,
        new Set([sourceId, terminalId]),
        new Set([flowId]),
      ).leases.map(({ actorId }) => actorId),
    ).toEqual(["exact-hauler", "safe-worker"]);
    expect(
      withoutSuppressedLeaseTargets(execution, new Set(), new Set()).leases.map(
        ({ actorId }) => actorId,
      ),
    ).not.toContain("exact-hauler");
  });

  it("fails flow admission for same-tick, malformed, mixed, over-capacity, and destination drift", () => {
    const empty = {
      budgets: [],
      demands: {
        edges: [],
        endpoints: [],
        nodes: [],
        suppressedSinkTargetIds: [],
        suppressedSourceTargetIds: [],
      },
    };
    expect(project(world(undefined, undefined, terms.startedAt), terms.startedAt)).toEqual(empty);
    expect(project(world(undefined, undefined, terms.expiresAt), terms.expiresAt)).toEqual(empty);
    for (const snapshot of [
      world(
        [
          ["H", 1],
          [terms.resourceType, terms.amount - 1],
        ],
        undefined,
      ),
      world([[terms.resourceType, terms.amount]], [[terms.resourceType, 298_000]]),
      {
        ...world(),
        rooms: [{ ...world().rooms[0], ownedTerminals: [] }],
      } as WorldSnapshot,
    ])
      expect(project(snapshot).demands.edges).toEqual([]);
    expect(
      projectLayoutStorageEvacuations({
        existingBudgets: [],
        quiescentTerminalRoomNames: new Set([roomName]),
        records: [record({ ...terms, amount: 0 })],
        snapshot: world(),
        tick: 11,
      }),
    ).toEqual(empty);
  });
});
