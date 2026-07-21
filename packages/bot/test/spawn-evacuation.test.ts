import { describe, expect, it } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import { emptyContractExecutionView, emptyContractPlanningView } from "../src/contracts";
import {
  emptyLayoutsOwner,
  layoutSpawnEvacuationBudgetIssuer,
  layoutSpawnEvacuationFlowId,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutSpawnEvacuation,
  type LayoutRecord,
} from "../src/layout";
import { planLogisticsRuntime } from "../src/logistics/runtime";
import {
  authorizedLayoutSpawnEvacuationBudgets,
  projectLayoutSpawnEvacuations,
} from "../src/logistics/spawn-evacuation";
import { ConstructionPlanner } from "../src/maintenance/construction-planner";
import { authorizeLayoutSpawnEvacuationFlowIds } from "../src/runtime/tick";
import type { WorldSnapshot } from "../src/world/snapshot";

const commitment = {
  algorithmRevision: "owned-room-layout-v2-source-services",
  anchor: { roomName: "W1N1", x: 25, y: 25 },
  blockers: [],
  committedAt: 10,
  fingerprint: "layout-spawn-a",
  transform: 0,
} as const;
const terms = {
  amount: 300,
  expiresAt: 160,
  replacementId: "spawn-replacement",
  replacementInitialEnergy: 0,
  sourceId: "spawn-obsolete",
  startedAt: 10,
} as const;

function spawn(
  id: string,
  x: number,
  energy: number,
  active = true,
  spawning: {
    readonly creepName: string;
    readonly needTime: number;
    readonly remainingTime: number;
  } | null = null,
) {
  return {
    active,
    hits: 5_000,
    hitsMax: 5_000,
    id,
    name: id,
    pos: { roomName: "W1N1", x, y: 10 },
    spawning,
    store: {
      capacity: 300,
      freeCapacity: 300 - energy,
      resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
      usedCapacity: energy,
    },
  };
}

function world(sourceEnergy = 300, replacementEnergy = 0, tick = 11): WorldSnapshot {
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
        name: "W1N1",
        observedAt: tick,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns: [
          spawn("spawn-obsolete", 10, sourceEnergy),
          spawn("spawn-replacement", 11, replacementEnergy),
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
        ownedSpawns: 2,
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
  return { ...commitment, roomName: "W1N1", spawnEvacuation: terms };
}

describe("stocked obsolete-spawn evacuation", () => {
  it("persists one exact V16 150-tick record and migrates V15 without inventing terms", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    const v15 = { ...owner, schemaVersion: 15 };
    expect(parseLayoutsOwner(v15)).toEqual({ ...owner, revision: owner.revision + 1 });
    expect(
      parseLayoutsOwner({
        ...v15,
        records: [{ ...v15.records[0], spawnEvacuation: terms }],
      }),
    ).toBeNull();

    owner = persistLayoutSpawnEvacuation(owner, "W1N1", terms);
    expect(owner.schemaVersion).toBe(16);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(persistLayoutCommitment(owner, "W1N1", commitment).records[0]?.spawnEvacuation).toEqual(
      terms,
    );
    expect(
      persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-spawn-b" })
        .records[0]?.spawnEvacuation,
    ).toBeUndefined();
    for (const malformed of [
      { ...terms, amount: 0 },
      { ...terms, amount: 301 },
      { ...terms, expiresAt: 159 },
      { ...terms, replacementInitialEnergy: 1 },
      { ...terms, replacementId: terms.sourceId },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], spawnEvacuation: malformed }],
        }),
      ).toBeNull();
  });

  it("projects one next-tick funded V3 flow with exact reservation and refill suppression", () => {
    const issuer = layoutSpawnEvacuationBudgetIssuer("W1N1", terms);
    const flowId = layoutSpawnEvacuationFlowId("W1N1", terms);
    if (issuer === null || flowId === null) throw new Error("expected bounded evacuation identity");
    const projection = projectLayoutSpawnEvacuations({
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
        maximumAmount: 300,
      }),
    ]);
    expect(projection.demands.endpoints).toEqual([
      expect.objectContaining({ acquireAction: "withdraw", targetId: "spawn-obsolete" }),
      expect.objectContaining({ targetId: "spawn-replacement" }),
    ]);
    expect(projection.demands.nodes).toContainEqual(
      expect.objectContaining({
        capacityReservationKey: "spawn:W1N1:spawn-replacement:energy-capacity",
        freeCapacity: 300,
      }),
    );
    expect(projection.demands.suppressedSinkTargetIds).toEqual([
      "spawn-obsolete",
      "spawn-replacement",
    ]);
    expect(authorizedLayoutSpawnEvacuationBudgets(projection, new Set())).toEqual([]);
    expect(authorizedLayoutSpawnEvacuationBudgets(projection, new Set([flowId]))).toEqual(
      projection.budgets,
    );
    const firstBudget = projection.budgets[0];
    const firstEdge = projection.demands.edges[0];
    if (firstBudget === undefined || firstEdge === undefined)
      throw new Error("expected projected evacuation budget and edge");
    const otherIssuer = "layout-migration/4:W2N2/7:source-b/6:sink-b";
    const independentProjection = {
      budgets: [...projection.budgets, { ...firstBudget, colonyId: "W2N2", issuer: otherIssuer }],
      demands: {
        ...projection.demands,
        edges: [
          ...projection.demands.edges,
          {
            ...firstEdge,
            budgetBinding: { category: "optional-growth" as const, issuer: otherIssuer },
            id: "layout-spawn-evacuation:W2N2:source-b:sink-b",
          },
        ],
      },
    };
    expect(
      authorizedLayoutSpawnEvacuationBudgets(independentProjection, new Set([flowId])),
    ).toEqual(projection.budgets);
    const logistics = planLogisticsRuntime({
      execution: emptyContractExecutionView("ready"),
      includeOptional: false,
      planning: emptyContractPlanningView("ready"),
      resourceDemands: projection.demands,
      snapshot: world(),
      tick: 11,
    });
    const logisticsCommitment = logistics.contracts.commitments.find(
      (commitment) => commitment.flowId === flowId,
    );
    if (logisticsCommitment?.request === null || logisticsCommitment?.request === undefined)
      throw new Error("expected executable spawn evacuation contract");
    expect(logisticsCommitment.request).toMatchObject({
      budgetBinding: { category: "optional-growth", issuer },
      execution: {
        action: "withdraw",
        counterpartId: "spawn-replacement",
        version: 3,
      },
      quantity: 300,
      targetId: "spawn-obsolete",
    });

    const afterAcquire = projectLayoutSpawnEvacuations({
      existingBudgets: [],
      records: JSON.parse(JSON.stringify([record()])) as LayoutRecord[],
      snapshot: world(0, 0, 12),
      tick: 12,
    });
    expect(afterAcquire.demands.suppressedSinkTargetIds).toEqual(["spawn-obsolete"]);
    expect(afterAcquire.demands.edges[0]?.maximumAmount).toBe(300);

    const consumedBaseline = projectLayoutSpawnEvacuations({
      existingBudgets: [],
      records: [
        {
          ...record(),
          spawnEvacuation: { ...terms, amount: 100, replacementInitialEnergy: 100 },
        },
      ],
      snapshot: world(0, 0, 12),
      tick: 12,
    });
    expect(consumedBaseline.demands.edges).toHaveLength(1);
    expect(consumedBaseline.demands.suppressedSinkTargetIds).toEqual(["spawn-obsolete"]);
  });

  it("suppresses stale flow execution when the current broker selects either migration spawn", () => {
    const flowId = layoutSpawnEvacuationFlowId("W1N1", terms);
    if (flowId === null) throw new Error("expected bounded spawn flow id");
    expect(authorizeLayoutSpawnEvacuationFlowIds([record()], new Set([flowId]), new Set())).toEqual(
      new Set([flowId]),
    );
    for (const selectedId of [terms.sourceId, terms.replacementId])
      expect(
        authorizeLayoutSpawnEvacuationFlowIds([record()], new Set([flowId]), new Set([selectedId])),
      ).toEqual(new Set());
  });

  it("stages, revalidates, retires, and removes only after exact endpoint and spawn evidence", () => {
    const policy = projectColonyRclPolicy({
      activeThreat: false,
      controllerLevel: 8,
      controllerRisk: false,
      cpuMode: "normal",
      energyAvailable: 12_900,
      energyCapacityAvailable: 12_900,
      protectedSpawnEnergy: 300,
      rcl8Health: null,
      state: "mature",
      visibility: "visible",
    });
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      id: "W1N1",
      legalWorkforce: true,
      rclPolicy: {
        ...policy,
        progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
      },
      roomName: "W1N1",
      state: "mature",
      visibility: "visible",
    } as ColonyView;
    const placements = [
      {
        adoption: "planned",
        layer: "primary",
        minimumRcl: 1,
        pos: { roomName: "W1N1", x: 20, y: 10 },
        structureType: "spawn",
      },
      {
        adoption: "planned",
        layer: "primary",
        minimumRcl: 7,
        pos: { roomName: "W1N1", x: 21, y: 10 },
        structureType: "spawn",
      },
      {
        adoption: "planned",
        layer: "primary",
        minimumRcl: 8,
        pos: { roomName: "W1N1", x: 22, y: 10 },
        structureType: "spawn",
      },
    ] as const;
    const exactA = spawn("spawn-retained", 20, 300);
    const replacement = spawn("spawn-replacement", 21, 0);
    const obsolete = spawn("spawn-obsolete", 30, 300);
    const room = (
      ownedSpawns: readonly ReturnType<typeof spawn>[],
      observedAt: number,
    ): WorldSnapshot["rooms"][number] =>
      ({
        constructionSites: [],
        controller: { level: 8, ownership: "owned" },
        hostileCreeps: [],
        name: "W1N1",
        observedAt,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns,
        ownedTowers: [],
        sources: [],
        storedStructures: [],
        structures: ownedSpawns.map((value) => ({
          hits: value.hits,
          hitsMax: value.hitsMax,
          id: value.id,
          ownerUsername: "me",
          ownership: "owned",
          pos: value.pos,
          structureType: "spawn",
        })),
      }) as unknown as WorldSnapshot["rooms"][number];
    const plan = (input: {
      readonly activeFlowIds?: ReadonlySet<string>;
      readonly activeLeasedTargetIds?: ReadonlySet<string>;
      readonly activeLogisticsEndpoints?: readonly {
        readonly counterpartId: string | null;
        readonly flowId: string;
        readonly targetId: string;
        readonly version?: number;
      }[];
      readonly activeTargetIds?: ReadonlySet<string>;
      readonly claims?: ReadonlySet<string>;
      readonly evacuation?: Parameters<ConstructionPlanner["planMigration"]>[0]["spawnEvacuation"];
      readonly observedAt: number;
      readonly spawns: readonly ReturnType<typeof spawn>[];
    }) =>
      new ConstructionPlanner().planMigration({
        activeLeasedWorkTargetIds: input.activeLeasedTargetIds ?? new Set(),
        activeLogisticsEndpoints: (input.activeLogisticsEndpoints ?? []).map((endpoint) => ({
          ...endpoint,
          version: endpoint.version ?? 1,
        })),
        activeLogisticsFlowIds: input.activeFlowIds ?? new Set(),
        activeLogisticsTargetIds: input.activeTargetIds ?? new Set(),
        activeSpawnClaimIds: input.claims ?? new Set([exactA.id]),
        colony,
        commitment,
        globalOwnedSiteCount: 0,
        logisticsEvidenceReady: true,
        observationFingerprint: `obs-${String(input.observedAt)}`,
        placements,
        policyFingerprint: "policy-spawn",
        room: room(input.spawns, input.observedAt),
        spawnEvacuation: input.evacuation ?? null,
      });

    const staged = plan({ observedAt: 10, spawns: [obsolete, replacement, exactA] });
    expect(staged.proposals).toEqual([]);
    expect(staged.spawnEvacuation).toEqual(terms);
    expect(staged.blockers).toContainEqual({
      reason: "target-stocked",
      roomName: "W1N1",
      targetId: obsolete.id,
    });
    const resetTerms = JSON.parse(JSON.stringify(staged.spawnEvacuation)) as typeof terms;
    const flowId = layoutSpawnEvacuationFlowId("W1N1", terms);
    if (flowId === null) throw new Error("expected flow id");
    const exactEndpoints = [
      { counterpartId: replacement.id, flowId, targetId: obsolete.id, version: 3 },
    ];
    const partial = plan({
      activeFlowIds: new Set([flowId]),
      activeLeasedTargetIds: new Set([obsolete.id, replacement.id]),
      activeLogisticsEndpoints: exactEndpoints,
      activeTargetIds: new Set([obsolete.id, replacement.id]),
      evacuation: resetTerms,
      observedAt: 11,
      spawns: [spawn(obsolete.id, 30, 150), spawn(replacement.id, 21, 150), exactA],
    });
    expect(partial.proposals).toEqual([]);
    expect(partial.spawnEvacuation).toEqual(terms);
    expect(partial.blockers).toContainEqual(expect.objectContaining({ reason: "target-stocked" }));
    const reordered = plan({
      activeFlowIds: new Set([flowId]),
      activeLeasedTargetIds: new Set([replacement.id, obsolete.id]),
      activeLogisticsEndpoints: exactEndpoints,
      activeTargetIds: new Set([replacement.id, obsolete.id]),
      evacuation: resetTerms,
      observedAt: 11,
      spawns: [exactA, spawn(replacement.id, 21, 150), spawn(obsolete.id, 30, 150)],
    });
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(partial));

    const postAcquire = plan({
      evacuation: resetTerms,
      observedAt: 12,
      spawns: [spawn(obsolete.id, 30, 0), spawn(replacement.id, 21, 0), exactA],
    });
    expect(postAcquire.proposals).toEqual([]);
    expect(postAcquire.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-incomplete" }),
    );
    const consumedBaseline = plan({
      evacuation: { ...resetTerms, amount: 100, replacementInitialEnergy: 100 },
      observedAt: 12,
      spawns: [spawn(obsolete.id, 30, 0), spawn(replacement.id, 21, 0), exactA],
    });
    expect(consumedBaseline.spawnEvacuation).toMatchObject({
      amount: 100,
      replacementInitialEnergy: 100,
    });
    expect(consumedBaseline.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-incomplete" }),
    );
    const unrelated = plan({
      activeLeasedTargetIds: new Set([replacement.id]),
      activeLogisticsEndpoints: [
        { counterpartId: replacement.id, flowId: "unrelated-flow", targetId: "storage" },
      ],
      activeTargetIds: new Set([replacement.id]),
      evacuation: resetTerms,
      observedAt: 13,
      spawns: [spawn(obsolete.id, 30, 0), spawn(replacement.id, 21, 300), exactA],
    });
    expect(unrelated.proposals).toEqual([]);
    expect(unrelated.blockers).toContainEqual(
      expect.objectContaining({ reason: "logistics-active" }),
    );
    const maskedUnrelated = plan({
      activeFlowIds: new Set([flowId]),
      activeLeasedTargetIds: new Set([obsolete.id, replacement.id]),
      activeLogisticsEndpoints: [
        ...exactEndpoints,
        {
          counterpartId: replacement.id,
          flowId,
          targetId: obsolete.id,
          version: 1,
        },
      ],
      activeTargetIds: new Set([obsolete.id, replacement.id]),
      evacuation: resetTerms,
      observedAt: 13,
      spawns: [spawn(obsolete.id, 30, 0), spawn(replacement.id, 21, 300), exactA],
    });
    expect(maskedUnrelated.proposals).toEqual([]);
    expect(maskedUnrelated.blockers).toContainEqual(
      expect.objectContaining({ reason: "logistics-active" }),
    );
    const selected = plan({
      claims: new Set([exactA.id, replacement.id]),
      evacuation: resetTerms,
      observedAt: 13,
      spawns: [spawn(obsolete.id, 30, 0), spawn(replacement.id, 21, 300), exactA],
    });
    expect(selected.proposals).toEqual([]);
    expect(selected.blockers).toContainEqual(expect.objectContaining({ reason: "spawn-selected" }));
    const expired = plan({
      evacuation: resetTerms,
      observedAt: terms.expiresAt,
      spawns: [spawn(obsolete.id, 30, 0), spawn(replacement.id, 21, 300), exactA],
    });
    expect(expired.proposals).toEqual([]);
    expect(expired.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-expired" }),
    );
    const ready = plan({
      evacuation: resetTerms,
      observedAt: 14,
      spawns: [spawn(obsolete.id, 30, 0), spawn(replacement.id, 21, 300), exactA],
    });
    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: replacement.id,
        targetId: obsolete.id,
        targetStructureType: "spawn",
      }),
    ]);
  });

  it("fails closed on same-tick, drift, expiry, malformed stores, and the record cap", () => {
    const empty = {
      budgets: [],
      demands: { edges: [], endpoints: [], nodes: [], suppressedSinkTargetIds: [] },
    };
    const project = (snapshot: WorldSnapshot, tick = 11, records = [record()]) =>
      projectLayoutSpawnEvacuations({ existingBudgets: [], records, snapshot, tick });

    const targetSuppressed = {
      ...empty,
      demands: { ...empty.demands, suppressedSinkTargetIds: ["spawn-obsolete"] },
    };
    expect(project(world(), 10)).toEqual(empty);
    expect(project(world(), 160)).toEqual(empty);
    expect(project(world(301, 0))).toEqual(targetSuppressed);
    expect(project(world(300, 1))).toEqual(targetSuppressed);
    const inactiveWorld = world();
    const inactiveRoom = inactiveWorld.rooms[0];
    if (inactiveRoom === undefined) throw new Error("expected observed room");
    expect(
      project({
        ...inactiveWorld,
        rooms: [
          {
            ...inactiveRoom,
            ownedSpawns: [
              spawn("spawn-obsolete", 10, 300, false),
              spawn("spawn-replacement", 11, 0),
            ],
          },
        ],
      }),
    ).toEqual(targetSuppressed);
    const duplicateWorld = world();
    const duplicateRoom = duplicateWorld.rooms[0];
    if (duplicateRoom === undefined) throw new Error("expected duplicate fixture room");
    expect(
      project({
        ...duplicateWorld,
        rooms: [
          {
            ...duplicateRoom,
            ownedSpawns: [...duplicateRoom.ownedSpawns, spawn("spawn-obsolete", 12, 300)],
          },
        ],
      }),
    ).toEqual(targetSuppressed);
    expect(project(world(), 11, Array.from({ length: 65 }, record))).toEqual(empty);
  });
});
