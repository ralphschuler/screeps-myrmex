import { describe, expect, it } from "vitest";
import {
  emptyContractExecutionView,
  emptyContractPlanningView,
  type ContractExecutionView,
} from "../src/contracts";
import {
  LAYOUT_ALGORITHM_REVISION,
  emptyLayoutsOwner,
  layoutTerminalEvacuationBudgetIssuer,
  layoutTerminalEvacuationFlowId,
  layoutTerminalEvacuationFlowIds,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutTerminalEvacuation,
  type LayoutRecord,
} from "../src/layout";
import { aggregateStoreCapacityReservationKey } from "../src/logistics/planner";
import { planLogisticsRuntime } from "../src/logistics/runtime";
import {
  completeExecutableLayoutTerminalEvacuationFlowIds,
  projectLayoutTerminalEvacuations,
} from "../src/logistics/terminal-evacuation";
import {
  isAuthorizedLayoutTerminalEvacuationFlowId,
  projectLayoutTerminalSendBlockedRoomNames,
  withoutSuppressedLeaseTargets,
} from "../src/runtime/tick";
import type { WorldSnapshot } from "../src/world/snapshot";

const roomName = "W1N1";
const sourceId = "terminal-obsolete";
const replacementId = "storage-active";
const commitment = {
  algorithmRevision: LAYOUT_ALGORITHM_REVISION,
  anchor: { roomName, x: 25, y: 25 },
  blockers: [],
  committedAt: 10,
  fingerprint: "layout-terminal-a",
  transform: 0,
} as const;
const terms = {
  amount: 3_000,
  expiresAt: 160,
  replacementId,
  replacementInitialAmount: 12_000,
  resourceType: "XGH2O",
  sourceId,
  startedAt: 10,
} as const;

function inventory(capacity: number, resources: readonly (readonly [string, number])[]) {
  const usedCapacity = resources.reduce((total, [, amount]) => total + amount, 0);
  return {
    capacity,
    freeCapacity: capacity - usedCapacity,
    resources: resources.map(([resourceType, amount]) => ({ amount, resourceType })),
    usedCapacity,
  };
}

function terminal(amount: number, tick: number) {
  return {
    active: true,
    cooldown: 0,
    hits: 3_000,
    hitsMax: 3_000,
    id: sourceId,
    pos: { roomName, x: 30, y: 30 },
    store: inventory(300_000, amount === 0 ? [] : [[terms.resourceType, amount]]),
    tick,
  };
}

function storage(amount: number) {
  return {
    active: true,
    hits: 10_000,
    hitsMax: 10_000,
    id: replacementId,
    pos: { roomName, x: 21, y: 20 },
    store: inventory(1_000_000, [[terms.resourceType, amount]]),
  };
}

function world(
  sourceAmount: number = terms.amount,
  replacementAmount: number = terms.replacementInitialAmount,
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
        ownedStorages: [storage(replacementAmount)],
        ownedTerminals: [terminal(sourceAmount, tick)],
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

function record(): LayoutRecord {
  return { ...commitment, roomName, terminalEvacuation: terms };
}

describe("stocked obsolete-terminal evacuation", () => {
  it("persists one exact scalar record and migrates V17/V18 without inventing terms", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    const v17 = { ...owner, schemaVersion: 17 };
    expect(parseLayoutsOwner(v17)).toEqual({ ...owner, revision: owner.revision + 1 });
    expect(
      parseLayoutsOwner({
        ...v17,
        records: [{ ...v17.records[0], terminalEvacuation: terms }],
      }),
    ).toBeNull();

    owner = persistLayoutTerminalEvacuation(owner, roomName, terms);
    expect(owner.schemaVersion).toBe(22);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    const migratedV18 = parseLayoutsOwner({ ...owner, schemaVersion: 18 });
    expect(migratedV18).toEqual({ ...owner, revision: owner.revision + 1 });
    const migratedTerms = migratedV18?.records[0]?.terminalEvacuation;
    if (migratedTerms === undefined) throw new Error("expected migrated scalar terms");
    expect([
      layoutTerminalEvacuationFlowId(roomName, migratedTerms),
      layoutTerminalEvacuationBudgetIssuer(roomName, migratedTerms),
    ]).toEqual([
      layoutTerminalEvacuationFlowId(roomName, terms),
      layoutTerminalEvacuationBudgetIssuer(roomName, terms),
    ]);
    expect(
      persistLayoutCommitment(owner, roomName, commitment).records[0]?.terminalEvacuation,
    ).toEqual(terms);
    expect(
      persistLayoutCommitment(owner, roomName, { ...commitment, fingerprint: "layout-terminal-b" })
        .records[0]?.terminalEvacuation,
    ).toBeUndefined();

    for (const malformed of [
      { ...terms, amount: 0 },
      { ...terms, amount: 3_001 },
      { ...terms, expiresAt: 159 },
      { ...terms, replacementInitialAmount: 998_000 },
      { ...terms, replacementId: terms.sourceId },
      { ...terms, resourceType: "" },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], terminalEvacuation: malformed }],
        }),
      ).toBeNull();
  });

  it("persists and atomically projects a canonical mixed-resource manifest", () => {
    const mixedTerms = {
      expiresAt: 160,
      replacementId,
      resourceManifest: [
        ["XGH2O", 1_500, 12_000],
        ["energy", 1_000, 25_000],
      ],
      sourceId,
      startedAt: 10,
    } as const;
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    owner = persistLayoutTerminalEvacuation(owner, roomName, mixedTerms);
    expect(owner.schemaVersion).toBe(22);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);

    const snapshot = world();
    const observedRoom = snapshot.rooms[0];
    const observedTerminal = observedRoom?.ownedTerminals?.[0];
    const observedStorage = observedRoom?.ownedStorages?.[0];
    if (
      observedRoom === undefined ||
      observedTerminal === undefined ||
      observedStorage === undefined
    )
      throw new Error("expected mixed terminal fixture");
    const mixedSnapshot = {
      ...snapshot,
      rooms: [
        {
          ...observedRoom,
          ownedStorages: [
            {
              ...observedStorage,
              store: inventory(1_000_000, [
                ["energy", 25_000],
                ["XGH2O", 12_000],
              ]),
            },
          ],
          ownedTerminals: [
            {
              ...observedTerminal,
              store: inventory(300_000, [
                ["energy", 1_000],
                ["XGH2O", 1_500],
              ]),
            },
          ],
        },
      ],
    };
    const projection = projectLayoutTerminalEvacuations({
      existingBudgets: [],
      records: [{ ...commitment, roomName, terminalEvacuation: mixedTerms }],
      snapshot: mixedSnapshot,
      tick: 11,
    });
    expect(projection.budgets).toHaveLength(2);
    expect(projection.demands.edges.map(({ id }) => id)).toEqual([
      layoutTerminalEvacuationFlowId(roomName, {
        replacementId,
        resourceType: "XGH2O",
        sourceId,
      }),
      layoutTerminalEvacuationFlowId(roomName, {
        replacementId,
        resourceType: "energy",
        sourceId,
      }),
    ]);
    expect(
      new Set(
        projection.demands.nodes.flatMap(({ capacityReservationKey }) =>
          capacityReservationKey === undefined ? [] : [capacityReservationKey],
        ),
      ),
    ).toEqual(new Set([aggregateStoreCapacityReservationKey(roomName, replacementId)]));
  });

  it("rejects malformed manifests and preserves V18 scalar-only semantics", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    const manifest = {
      expiresAt: 160,
      replacementId,
      resourceManifest: [
        ["XGH2O", 1_500, 12_000],
        ["energy", 1_000, 25_000],
      ],
      sourceId,
      startedAt: 10,
    } as const;
    const withManifest = { ...owner.records[0], terminalEvacuation: manifest };
    expect(parseLayoutsOwner({ ...owner, records: [withManifest] })).not.toBeNull();
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 18, records: [withManifest] })).toBeNull();
    for (const resourceManifest of [
      [["XGH2O", 1_500, 12_000]],
      [
        ["energy", 1_000, 25_000],
        ["XGH2O", 1_500, 12_000],
      ],
      [
        ["XGH2O", 1_500, 12_000],
        ["XGH2O", 1_000, 25_000],
      ],
      [
        ["XGH2O", 2_001, 12_000],
        ["energy", 1_000, 25_000],
      ],
      [
        ["XGH2O", 1_500, 998_000],
        ["energy", 1_000, 1_000],
      ],
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], terminalEvacuation: { ...manifest, resourceManifest } }],
        }),
      ).toBeNull();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [
          {
            ...owner.records[0],
            terminalEvacuation: { ...manifest, amount: 2_500, resourceType: "energy" },
          },
        ],
      }),
    ).toBeNull();
  });

  it("keeps each currently projected manifest subset atomic", () => {
    const manifest = {
      expiresAt: 160,
      replacementId,
      resourceManifest: [
        ["XGH2O", 1_500, 12_000],
        ["energy", 1_000, 25_000],
      ],
      sourceId,
      startedAt: 10,
    } as const;
    const manifestRecord = {
      ...commitment,
      roomName,
      terminalEvacuation: manifest,
    } as LayoutRecord;
    const evacuation = manifestRecord.terminalEvacuation;
    if (evacuation === undefined) throw new Error("expected manifest terms");
    const flowIds = layoutTerminalEvacuationFlowIds(roomName, evacuation);
    const firstFlowId = flowIds?.[0];
    const secondFlowId = flowIds?.[1];
    if (flowIds === null || firstFlowId === undefined || secondFlowId === undefined)
      throw new Error("expected manifest identities");
    const partiallyFunded = completeExecutableLayoutTerminalEvacuationFlowIds({
      executableFlowIds: new Set([firstFlowId]),
      projectedFlowIds: new Set(flowIds),
      records: [manifestRecord],
    });
    expect(partiallyFunded).toEqual(new Set());
    expect(
      flowIds.map((flowId) =>
        isAuthorizedLayoutTerminalEvacuationFlowId(flowId, new Set(flowIds), partiallyFunded),
      ),
    ).toEqual([false, false]);
    expect(
      completeExecutableLayoutTerminalEvacuationFlowIds({
        executableFlowIds: new Set(flowIds),
        projectedFlowIds: new Set(flowIds),
        records: [manifestRecord],
      }),
    ).toEqual(new Set(flowIds));
    expect(
      completeExecutableLayoutTerminalEvacuationFlowIds({
        executableFlowIds: new Set([secondFlowId]),
        projectedFlowIds: new Set([secondFlowId]),
        records: [manifestRecord],
      }),
    ).toEqual(new Set([secondFlowId]));
  });

  it("drops an over-64-flow manifest batch atomically while retaining suppression", () => {
    const baseRoom = world().rooms[0];
    const baseTerminal = baseRoom?.ownedTerminals?.[0];
    const baseStorage = baseRoom?.ownedStorages?.[0];
    if (baseRoom === undefined || baseTerminal === undefined || baseStorage === undefined)
      throw new Error("expected overflow fixtures");
    const records: LayoutRecord[] = [];
    const rooms: WorldSnapshot["rooms"][number][] = [];
    for (let index = 0; index < 33; index += 1) {
      const currentRoomName = `W${String(index)}N1`;
      const currentSourceId = `${sourceId}-${String(index)}`;
      const currentReplacementId = `${replacementId}-${String(index)}`;
      records.push({
        ...commitment,
        anchor: { ...commitment.anchor, roomName: currentRoomName },
        roomName: currentRoomName,
        terminalEvacuation: {
          expiresAt: 160,
          replacementId: currentReplacementId,
          resourceManifest: [
            ["XGH2O", 1_500, 12_000],
            ["energy", 1_000, 25_000],
          ],
          sourceId: currentSourceId,
          startedAt: 10,
        },
      });
      rooms.push({
        ...baseRoom,
        name: currentRoomName,
        ownedStorages: [
          {
            ...baseStorage,
            id: currentReplacementId,
            pos: { ...baseStorage.pos, roomName: currentRoomName },
            store: inventory(1_000_000, [
              ["energy", 25_000],
              ["XGH2O", 12_000],
            ]),
          },
        ],
        ownedTerminals: [
          {
            ...baseTerminal,
            id: currentSourceId,
            pos: { ...baseTerminal.pos, roomName: currentRoomName },
            store: inventory(300_000, [
              ["energy", 1_000],
              ["XGH2O", 1_500],
            ]),
          },
        ],
      });
    }
    const projection = projectLayoutTerminalEvacuations({
      existingBudgets: [],
      records,
      snapshot: { ...world(), rooms },
      tick: 11,
    });
    expect(projection.budgets).toEqual([]);
    expect(projection.demands.edges).toEqual([]);
    expect(projection.demands.nodes).toEqual([]);
    expect(projection.demands.suppressedSourceTargetIds).toHaveLength(33);
  });

  it("keeps the persisted room unavailable to every internal terminal send", () => {
    expect(projectLayoutTerminalSendBlockedRoomNames([record()], 11)).toEqual(new Set([roomName]));
    expect(projectLayoutTerminalSendBlockedRoomNames([record()], terms.expiresAt)).toEqual(
      new Set(),
    );
    const { terminalEvacuation: _evacuation, ...withoutEvacuation } = record();
    void _evacuation;
    expect(projectLayoutTerminalSendBlockedRoomNames([withoutEvacuation], 11)).toEqual(new Set());
  });

  it("allows only the currently authorized evacuation lease to name suppressed endpoints", () => {
    const flowId = layoutTerminalEvacuationFlowId(roomName, terms);
    if (flowId === null) throw new Error("expected bounded terminal identity");
    const execution = {
      leases: [
        {
          actorId: "exact-hauler",
          execution: { counterpartId: replacementId, flowId, version: 3 },
          targetId: sourceId,
        },
        {
          actorId: "stale-hauler",
          execution: { counterpartId: replacementId, flowId: "stale-flow", version: 3 },
          targetId: sourceId,
        },
        {
          actorId: "safe-worker",
          execution: { counterpartId: null, flowId: "safe-flow", version: 1 },
          targetId: "safe-source",
        },
      ],
      status: "ready",
    } as unknown as ContractExecutionView;
    const filtered = withoutSuppressedLeaseTargets(
      execution,
      new Set([sourceId, replacementId]),
      new Set([flowId]),
    );
    expect(filtered.leases.map(({ actorId }) => actorId)).toEqual(["exact-hauler", "safe-worker"]);
  });

  it("projects one next-tick funded V3 flow with aggregate storage reservation and terminal suppression", () => {
    const issuer = layoutTerminalEvacuationBudgetIssuer(roomName, terms);
    const flowId = layoutTerminalEvacuationFlowId(roomName, terms);
    if (issuer === null || flowId === null) throw new Error("expected bounded terminal identity");

    const projection = projectLayoutTerminalEvacuations({
      existingBudgets: [],
      records: [record()],
      snapshot: world(),
      tick: 11,
    });
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
      expect.objectContaining({ targetId: replacementId }),
    ]);
    expect(projection.demands.nodes).toContainEqual(
      expect.objectContaining({
        capacityReservationKey: aggregateStoreCapacityReservationKey(roomName, replacementId),
        resourceType: terms.resourceType,
      }),
    );
    expect(projection.demands.suppressedSinkTargetIds).toEqual([sourceId]);
    expect(projection.demands.suppressedSourceTargetIds).toEqual([sourceId]);

    const logistics = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: projection.demands,
      snapshot: world(),
      tick: 11,
    });
    const request = logistics.contracts.commitments.find(
      (candidate) => candidate.flowId === flowId,
    )?.request;
    expect(request).toMatchObject({
      budgetBinding: { category: "optional-growth", issuer },
      execution: {
        action: "withdraw",
        counterpartId: replacementId,
        resourceType: terms.resourceType,
        version: 3,
      },
      quantity: terms.amount,
      targetId: sourceId,
    });

    const partial = projectLayoutTerminalEvacuations({
      existingBudgets: projection.budgets.map((budget) => ({ ...budget, status: "active" })),
      records: JSON.parse(JSON.stringify([record()])) as LayoutRecord[],
      snapshot: world(1_500, 13_500, 12),
      tick: 12,
    });
    expect(partial.demands.edges).toHaveLength(1);
    expect(partial.demands.suppressedSinkTargetIds).toEqual([sourceId]);
    expect(partial.demands.suppressedSourceTargetIds).toEqual([sourceId]);
  });

  it("retains terminal suppression when an oversized optional demand batch is dropped", () => {
    const snapshot = world();
    const observedRoom = snapshot.rooms[0];
    const observedTerminal = observedRoom?.ownedTerminals?.[0];
    if (observedRoom === undefined || observedTerminal === undefined)
      throw new Error("expected terminal fixture");
    const runtime = planLogisticsRuntime({
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
        suppressedSinkTargetIds: [sourceId],
        suppressedSourceTargetIds: [sourceId],
      },
      snapshot: {
        ...snapshot,
        rooms: [
          {
            ...observedRoom,
            storedStructures: [
              {
                ...observedTerminal,
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
    expect(runtime.graph.nodes).not.toContainEqual(
      expect.objectContaining({ id: `store:${sourceId}:source:${terms.resourceType}` }),
    );
  });

  it("fails closed on same-tick, expiry, mixed/refilled stock, destination loss, and record overflow", () => {
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
    const suppressed = {
      ...empty,
      demands: {
        ...empty.demands,
        suppressedSinkTargetIds: [sourceId],
        suppressedSourceTargetIds: [sourceId],
      },
    };
    const project = (snapshot: WorldSnapshot, tick: number, records = [record()]) =>
      projectLayoutTerminalEvacuations({ existingBudgets: [], records, snapshot, tick });

    expect(project(world(terms.amount, terms.replacementInitialAmount, 10), 10)).toEqual(empty);
    expect(project(world(0, terms.replacementInitialAmount + terms.amount, 160), 160)).toEqual(
      empty,
    );
    expect(project(world(terms.amount, terms.replacementInitialAmount - 1, 11), 11)).toEqual(
      suppressed,
    );
    expect(project(world(terms.amount, terms.replacementInitialAmount + 1_500, 11), 11)).toEqual(
      suppressed,
    );
    expect(project(world(0, terms.replacementInitialAmount + terms.amount + 1, 11), 11)).toEqual(
      suppressed,
    );

    const mixed = world();
    const mixedRoom = mixed.rooms[0];
    const mixedTerminal = mixedRoom?.ownedTerminals?.[0];
    if (mixedRoom === undefined || mixedTerminal === undefined)
      throw new Error("expected terminal fixture");
    expect(
      project(
        {
          ...mixed,
          rooms: [
            {
              ...mixedRoom,
              ownedTerminals: [
                {
                  ...mixedTerminal,
                  store: inventory(300_000, [
                    [terms.resourceType, 1_500],
                    ["energy", 1_500],
                  ]),
                },
              ],
            },
          ],
        },
        11,
      ),
    ).toEqual(suppressed);
    expect(project(world(), 11, Array.from({ length: 65 }, record))).toEqual(empty);
  });
});
