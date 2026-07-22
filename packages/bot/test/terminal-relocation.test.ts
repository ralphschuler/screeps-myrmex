import { describe, expect, it, vi } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import type { IndustryTerminalWorkRoomView } from "../src/industry";
import {
  LAYOUT_ALGORITHM_REVISION,
  STRUCTURE_REMOVAL_LIMITS,
  StructureDestroyExecutor,
  arbitrateStructureRemovals,
  diffOwnedRoomLayout,
  emptyLayoutsOwner,
  layoutTerminalEvacuationFlowId,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutTerminalEvacuation,
  reconcileStructureDestroyExecution,
  type LayoutCommitment,
  type LayoutPlacement,
} from "../src/layout";
import { ConstructionPlanner } from "../src/maintenance";
import type { RoomSnapshot } from "../src/world/snapshot";

const roomName = "W1N1";
const pos = (x: number, y: number) => ({ roomName, x, y });
const targetId = "terminal-obsolete";
const storageId = "storage-active";
const commitment: LayoutCommitment = {
  algorithmRevision: LAYOUT_ALGORITHM_REVISION,
  anchor: pos(25, 25),
  blockers: [],
  committedAt: 1,
  fingerprint: "layout-terminal-a",
  transform: 0,
};
const terminalPlacement: LayoutPlacement = {
  adoption: "planned",
  layer: "primary",
  minimumRcl: 6,
  pos: pos(20, 20),
  structureType: "terminal",
};
const projectedPolicy = projectColonyRclPolicy({
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
const policy = {
  ...projectedPolicy,
  progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
} as ColonyView["rclPolicy"];
const colony = {
  activeThreat: false,
  controllerRisk: false,
  id: roomName,
  legalWorkforce: true,
  rclPolicy: policy,
  roomName,
  state: "mature",
  visibility: "visible",
} as ColonyView;
const quiescent: IndustryTerminalWorkRoomView = { roomName, status: "quiescent" };

function resourceStore(
  capacity: number,
  resources: readonly (readonly [resourceType: string, amount: number])[],
) {
  const usedCapacity = resources.reduce((total, [, amount]) => total + amount, 0);
  return {
    capacity,
    freeCapacity: capacity - usedCapacity,
    resources: resources.map(([resourceType, amount]) => ({ amount, resourceType })),
    usedCapacity,
  };
}
function store(capacity: number, usedCapacity = 0) {
  return resourceStore(capacity, usedCapacity === 0 ? [] : [["energy", usedCapacity]]);
}
function terminal(overrides: Partial<NonNullable<RoomSnapshot["ownedTerminals"]>[number]> = {}) {
  return {
    active: true,
    cooldown: 0,
    hits: 3_000,
    hitsMax: 3_000,
    id: targetId,
    pos: pos(30, 30),
    store: store(300_000),
    ...overrides,
  };
}
function storage(overrides: Partial<NonNullable<RoomSnapshot["ownedStorages"]>[number]> = {}) {
  return {
    active: true,
    hits: 10_000,
    hitsMax: 10_000,
    id: storageId,
    pos: pos(21, 20),
    store: store(1_000_000, 25_000),
    ...overrides,
  };
}
function room(
  input: {
    readonly controllerLevel?: number;
    readonly observedAt?: number;
    readonly storage?: ReturnType<typeof storage> | null;
    readonly target?: ReturnType<typeof terminal> | null;
  } = {},
): RoomSnapshot {
  const observedAt = input.observedAt ?? 100;
  const target = input.target === undefined ? terminal() : input.target;
  const retainedStorage = input.storage === undefined ? storage() : input.storage;
  const structures = [
    ...(target === null
      ? []
      : [
          {
            hits: target.hits,
            hitsMax: target.hitsMax,
            id: target.id,
            ownerUsername: "me",
            ownership: "owned" as const,
            pos: target.pos,
            structureType: "terminal",
          },
        ]),
    ...(retainedStorage === null
      ? []
      : [
          {
            hits: retainedStorage.hits,
            hitsMax: retainedStorage.hitsMax,
            id: retainedStorage.id,
            ownerUsername: "me",
            ownership: "owned" as const,
            pos: retainedStorage.pos,
            structureType: "storage",
          },
        ]),
  ];
  return {
    constructionSites: [],
    controller: { level: input.controllerLevel ?? 8, ownership: "owned" },
    energyAvailable: 12_900,
    energyCapacityAvailable: 12_900,
    hostileCreeps: [],
    name: roomName,
    observedAt,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedStorages: retainedStorage === null ? [] : [retainedStorage],
    ownedTerminals: target === null ? [] : [target],
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    structures,
  } as unknown as RoomSnapshot;
}

function plan(
  input: {
    readonly activeEndpoints?: readonly {
      readonly counterpartId: string | null;
      readonly flowId: string | null;
      readonly targetId: string;
      readonly version: number;
    }[];
    readonly activeFlowIds?: ReadonlySet<string>;
    readonly activeLeasedTargetIds?: ReadonlySet<string>;
    readonly activeTargetIds?: ReadonlySet<string>;
    readonly industry?: IndustryTerminalWorkRoomView | null;
    readonly logisticsEvidenceReady?: boolean;
    readonly labEvacuation?: Parameters<ConstructionPlanner["planMigration"]>[0]["labEvacuation"];
    readonly removalReceipt?: Parameters<ConstructionPlanner["planMigration"]>[0]["removalReceipt"];
    readonly room?: RoomSnapshot;
    readonly terminalEvacuation?: Parameters<
      ConstructionPlanner["planMigration"]
    >[0]["terminalEvacuation"];
  } = {},
) {
  const activeTargetIds =
    input.activeTargetIds ??
    new Set(
      (input.activeEndpoints ?? []).flatMap(({ counterpartId, targetId }) =>
        counterpartId === null ? [targetId] : [targetId, counterpartId],
      ),
    );
  return new ConstructionPlanner().planMigration({
    activeLeasedWorkTargetIds: input.activeLeasedTargetIds ?? new Set(),
    activeLogisticsEndpoints: input.activeEndpoints ?? [],
    activeLogisticsFlowIds: input.activeFlowIds ?? new Set(),
    activeLogisticsTargetIds: activeTargetIds,
    activeTerminalLogisticsTargetIds: activeTargetIds,
    colony,
    commitment,
    globalOwnedSiteCount: 0,
    industryTerminalWork: input.industry === undefined ? quiescent : input.industry,
    labEvacuation: input.labEvacuation ?? null,
    logisticsEvidenceReady: input.logisticsEvidenceReady ?? true,
    observationFingerprint: `obs-${String(input.room?.observedAt ?? 100)}`,
    placements: [terminalPlacement],
    policyFingerprint: "policy-terminal",
    removalReceipt: input.removalReceipt ?? null,
    room: input.room ?? room(),
    terminalEvacuation: input.terminalEvacuation ?? null,
  });
}

describe("empty obsolete-terminal relocation", () => {
  it("authorizes one terminal-to-storage removal and reconstructs committed geometry", () => {
    const ready = plan();
    expect(ready).toMatchObject({
      blockers: [],
      proposals: [
        {
          replacementExpectedStoreCapacity: 1_000_000,
          replacementId: storageId,
          replacementStructureType: "storage",
          targetId,
          targetRequiresEmptyStore: true,
          targetRequiresZeroCooldown: true,
          targetStructureType: "terminal",
        },
      ],
    });
    expect(ready.proposals[0]?.stableId).toContain("remove-terminal-v1");
    const reorderedRoom = room();
    expect(
      JSON.stringify(
        plan({
          room: {
            ...reorderedRoom,
            structures: [...(reorderedRoom.structures ?? [])].reverse(),
          },
        }),
      ),
    ).toBe(JSON.stringify(ready));
    if (ready.authorization === null) throw new Error("expected migration authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    });
    expect(arbitration.intents).toEqual([
      expect.objectContaining({
        replacementExpectedStoreCapacity: 1_000_000,
        replacementId: storageId,
        replacementStructureType: "storage",
        targetId,
        targetRequiresZeroCooldown: true,
        targetStructureType: "terminal",
      }),
    ]);

    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const target = {
      cooldown: 0,
      destroy,
      id: targetId,
      isActive: () => true,
      my: true,
      pos: pos(30, 30),
      room: liveRoom,
      store: liveStore(300_000, 0),
      structureType: "terminal",
    } as unknown as Structure;
    const retainedStorage = {
      id: storageId,
      isActive: () => true,
      my: true,
      pos: pos(21, 20),
      room: liveRoom,
      store: liveStore(1_000_000, 25_000),
      structureType: "storage",
    } as unknown as Structure;
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === targetId ? target : id === storageId ? retainedStorage : null,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK", fault: null })]);
    expect(destroy).toHaveBeenCalledOnce();

    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    owner = reconcileStructureDestroyExecution(owner, execution, 100).owner;
    expect(owner.schemaVersion).toBe(21);
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const receipt = owner.records[0]?.removalReceipt ?? null;
    expect(receipt).toMatchObject({ replacementId: storageId, targetStructureType: "terminal" });
    const pendingRoom = room();
    expect(
      plan({
        removalReceipt: receipt,
        room: { ...pendingRoom, structures: [...(pendingRoom.structures ?? [])].reverse() },
      }).proposals,
    ).toEqual([]);
    expect(
      plan({ removalReceipt: receipt, room: room({ observedAt: 101, target: null }) }),
    ).toMatchObject({
      removalReceipt: null,
    });

    const finalDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-101",
      placements: [terminalPlacement],
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-terminal",
      roomName,
      roomStatus: "owned",
      structures: room({ observedAt: 101, target: null }).structures ?? [],
    });
    expect(finalDiff.proposals).toEqual([
      expect.objectContaining({ pos: terminalPlacement.pos, structureType: "terminal" }),
    ]);
  });

  it("admits the official RCL6 boundary and rejects a current RCL5 room", () => {
    expect(plan({ room: room({ controllerLevel: 6 }) }).proposals).toHaveLength(1);
    expect(plan({ room: room({ controllerLevel: 5 }) })).toMatchObject({
      blockers: [expect.objectContaining({ reason: "replacement-pending" })],
      proposals: [],
    });
  });

  it("rejects malformed cross-type authority and freshly revalidates both live stores", () => {
    const ready = plan();
    if (ready.authorization === null || ready.proposals[0] === undefined)
      throw new Error("expected terminal proposal");
    for (const malformed of [
      { ...ready.proposals[0], replacementExpectedStoreCapacity: 999_999 },
      { ...ready.proposals[0], replacementStructureType: "terminal" },
      { ...ready.proposals[0], targetRequiresZeroCooldown: false },
    ])
      expect(
        arbitrateStructureRemovals({
          authorizations: [ready.authorization],
          limits: STRUCTURE_REMOVAL_LIMITS,
          proposals: [malformed as never],
        }).rejected[0]?.reason,
      ).toBe("invalid-proposal");

    const intent = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    }).intents[0];
    if (intent === undefined) throw new Error("expected terminal intent");
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const target = (used = 0, cooldown = 0) =>
      ({
        cooldown,
        destroy: vi.fn(() => 0),
        id: targetId,
        isActive: () => true,
        my: true,
        pos: pos(30, 30),
        room: liveRoom,
        store: liveStore(300_000, used),
        structureType: "terminal",
      }) as unknown as Structure;
    const retainedStorage = (capacity = 1_000_000) =>
      ({
        id: storageId,
        isActive: () => true,
        my: true,
        pos: pos(21, 20),
        room: liveRoom,
        store: liveStore(capacity, 25_000),
        structureType: "storage",
      }) as unknown as Structure;
    const execute = (terminal: Structure, storage: Structure | null) =>
      new StructureDestroyExecutor().execute([intent], {
        hasCurrentHostiles: () => false,
        isCurrentCommitment: () => true,
        resolveRoom: () => liveRoom,
        resolveStructure: (id) => (id === targetId ? terminal : id === storageId ? storage : null),
      })[0];

    expect(execute(target(1), retainedStorage())).toMatchObject({
      called: false,
      fault: "target-not-empty",
    });
    expect(execute(target(0, 1), retainedStorage())).toMatchObject({
      called: false,
      fault: "target-cooldown",
    });
    expect(execute(target(), retainedStorage(999_999))).toMatchObject({
      called: false,
      fault: "replacement-store-mismatch",
    });
    expect(execute(target(), null)).toMatchObject({
      called: false,
      fault: "replacement-absent",
    });
  });

  it("stages and resumes one bounded single-resource evacuation before removal", () => {
    const staged = plan({ room: room({ target: terminal({ store: store(300_000, 1_000) }) }) });
    expect(staged.proposals).toEqual([]);
    expect(staged.terminalEvacuation).toEqual({
      amount: 1_000,
      expiresAt: 250,
      replacementId: storageId,
      replacementInitialAmount: 25_000,
      resourceType: "energy",
      sourceId: targetId,
      startedAt: 100,
    });
    expect(staged.blockers).toContainEqual({
      reason: "target-stocked",
      roomName,
      targetId,
    });
    const terms = JSON.parse(JSON.stringify(staged.terminalEvacuation)) as NonNullable<
      typeof staged.terminalEvacuation
    >;
    const flowId = layoutTerminalEvacuationFlowId(roomName, terms);
    if (flowId === null) throw new Error("expected bounded terminal flow identity");
    const endpoints = [
      {
        counterpartId: storageId,
        flowId,
        targetId,
        version: 3,
      },
    ];
    const partial = plan({
      activeEndpoints: endpoints,
      activeFlowIds: new Set([flowId]),
      activeLeasedTargetIds: new Set([targetId, storageId]),
      room: room({
        observedAt: 101,
        storage: storage({ store: store(1_000_000, 25_500) }),
        target: terminal({ store: store(300_000, 500) }),
      }),
      terminalEvacuation: terms,
    });
    expect(partial.proposals).toEqual([]);
    expect(partial.terminalEvacuation).toEqual(terms);
    expect(partial.blockers).toContainEqual(expect.objectContaining({ reason: "target-stocked" }));

    const ready = plan({
      room: room({
        observedAt: 102,
        storage: storage({ store: store(1_000_000, 26_000) }),
        target: terminal(),
      }),
      terminalEvacuation: terms,
    });
    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: storageId,
        targetId,
      }),
    ]);
    expect(ready.proposals[0]?.stableId).toContain("remove-terminal-v2");
    expect(ready.terminalEvacuation).toEqual(terms);

    const destinationConsumed = plan({
      room: room({
        observedAt: 102,
        storage: storage({ store: store(1_000_000, 24_000) }),
        target: terminal(),
      }),
      terminalEvacuation: terms,
    });
    expect(destinationConsumed.proposals).toEqual([]);
    expect(destinationConsumed.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-incomplete" }),
    );

    const destinationOvergain = plan({
      room: room({
        observedAt: 102,
        storage: storage({ store: store(1_000_000, 26_001) }),
        target: terminal(),
      }),
      terminalEvacuation: terms,
    });
    expect(destinationOvergain.proposals).toEqual([]);
    expect(destinationOvergain.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-incomplete" }),
    );

    const expired = plan({
      room: room({
        observedAt: terms.expiresAt,
        storage: storage({ store: store(1_000_000, 25_500) }),
        target: terminal(),
      }),
      terminalEvacuation: terms,
    });
    expect(expired.proposals).toEqual([]);
    expect(expired.terminalEvacuation).toEqual(terms);
    expect(expired.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-expired" }),
    );
  });

  it("stages and completes one deterministic mixed-resource terminal evacuation", () => {
    const initialRoom = room({
      storage: storage({
        store: resourceStore(1_000_000, [
          ["energy", 25_000],
          ["XGH2O", 12_000],
        ]),
      }),
      target: terminal({
        store: resourceStore(300_000, [
          ["energy", 1_000],
          ["XGH2O", 500],
        ]),
      }),
    });
    const staged = plan({ room: initialRoom });
    expect(staged.proposals).toEqual([]);
    expect(staged.terminalEvacuation).toEqual({
      expiresAt: 250,
      replacementId: storageId,
      resourceManifest: [
        ["XGH2O", 500, 12_000],
        ["energy", 1_000, 25_000],
      ],
      sourceId: targetId,
      startedAt: 100,
    });
    const reorderedTarget = initialRoom.ownedTerminals?.[0];
    const reorderedStorage = initialRoom.ownedStorages?.[0];
    if (reorderedTarget === undefined || reorderedStorage === undefined)
      throw new Error("expected mixed terminal fixtures");
    expect(
      plan({
        room: room({
          storage: {
            ...reorderedStorage,
            store: resourceStore(1_000_000, [
              ["XGH2O", 12_000],
              ["energy", 25_000],
            ]),
          },
          target: {
            ...reorderedTarget,
            store: resourceStore(300_000, [
              ["XGH2O", 500],
              ["energy", 1_000],
            ]),
          },
        }),
      }).terminalEvacuation,
    ).toEqual(staged.terminalEvacuation);

    const terms = JSON.parse(JSON.stringify(staged.terminalEvacuation)) as NonNullable<
      typeof staged.terminalEvacuation
    >;
    const partial = plan({
      room: room({
        observedAt: 101,
        storage: storage({
          store: resourceStore(1_000_000, [
            ["energy", 25_600],
            ["XGH2O", 12_500],
          ]),
        }),
        target: terminal({ store: resourceStore(300_000, [["energy", 400]]) }),
      }),
      terminalEvacuation: terms,
    });
    expect(partial.proposals).toEqual([]);
    expect(partial.blockers).toContainEqual(expect.objectContaining({ reason: "target-stocked" }));

    const deliveredRoom = room({
      observedAt: 102,
      storage: storage({
        store: resourceStore(1_000_000, [
          ["energy", 26_000],
          ["XGH2O", 12_500],
        ]),
      }),
      target: terminal(),
    });
    const nonRetired = plan({
      activeTargetIds: new Set([targetId, storageId]),
      room: deliveredRoom,
      terminalEvacuation: terms,
    });
    expect(nonRetired.proposals).toEqual([]);
    expect(nonRetired.blockers).toContainEqual(
      expect.objectContaining({ reason: "logistics-active" }),
    );

    const ready = plan({ room: deliveredRoom, terminalEvacuation: terms });
    expect(ready.proposals).toEqual([
      expect.objectContaining({ replacementId: storageId, targetId }),
    ]);
    if (ready.authorization === null) throw new Error("expected mixed removal authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    });
    expect(arbitration.intents).toHaveLength(1);

    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const liveTarget = {
      cooldown: 0,
      destroy,
      id: targetId,
      isActive: () => true,
      my: true,
      pos: pos(30, 30),
      room: liveRoom,
      store: liveStore(300_000, 0),
      structureType: "terminal",
    } as unknown as Structure;
    const liveStorage = {
      id: storageId,
      isActive: () => true,
      my: true,
      pos: pos(21, 20),
      room: liveRoom,
      store: liveStore(1_000_000, 38_500),
      structureType: "storage",
    } as unknown as Structure;
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === targetId ? liveTarget : id === storageId ? liveStorage : null,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();

    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    owner = persistLayoutTerminalEvacuation(owner, roomName, terms);
    owner = reconcileStructureDestroyExecution(owner, execution, 102).owner;
    const receipt = owner.records[0]?.removalReceipt ?? null;
    expect(owner.records[0]?.terminalEvacuation).toEqual(terms);
    expect(
      plan({
        removalReceipt: receipt,
        room: deliveredRoom,
        terminalEvacuation: terms,
      }).proposals,
    ).toEqual([]);
    expect(
      plan({
        removalReceipt: receipt,
        room: room({ observedAt: 103, target: null }),
        terminalEvacuation: terms,
      }),
    ).toMatchObject({ removalReceipt: null, terminalEvacuation: null });

    expect(
      diffOwnedRoomLayout({
        colonyId: roomName,
        commitment,
        commitmentConflicted: false,
        constructionSites: [],
        observationFingerprint: "obs-103",
        placements: [terminalPlacement],
        policy,
        policyEnabled: true,
        policyFingerprint: "policy-terminal",
        roomName,
        roomStatus: "owned",
        structures: room({ observedAt: 103, target: null }).structures ?? [],
      }).proposals,
    ).toEqual([expect.objectContaining({ structureType: "terminal" })]);
  });

  it("fails closed for terminal work, endpoint contention, stock, cooldown, or storage drift", () => {
    const visible = room();
    const blockedSite = {
      ...visible,
      structures: [
        ...(visible.structures ?? []),
        {
          hits: 1_000,
          hitsMax: 1_000,
          id: "factory-blocking-terminal",
          ownerUsername: "me",
          ownership: "owned" as const,
          pos: terminalPlacement.pos,
          structureType: "factory",
        },
      ],
    };
    const cases = [
      plan({ industry: null }),
      plan({ industry: { roomName, status: "active" } }),
      plan({
        activeEndpoints: [{ counterpartId: storageId, flowId: "flow", targetId, version: 3 }],
      }),
      plan({ activeTargetIds: new Set([targetId]) }),
      plan({ logisticsEvidenceReady: false }),
      plan({
        labEvacuation: {
          amount: 100,
          destinationId: targetId,
          destinationInitialAmount: 0,
          destinationStructureType: "terminal",
          expiresAt: 250,
          replacementId: "lab-retained",
          resourceType: "H",
          sourceId: "lab-obsolete",
          startedAt: 100,
        },
      }),
      plan({ room: room({ target: terminal({ store: store(300_000, 1) }) }) }),
      plan({ room: room({ target: terminal({ cooldown: 1 }) }) }),
      plan({ room: room({ storage: null }) }),
      plan({ room: room({ storage: storage({ active: false }) }) }),
      plan({ room: room({ storage: storage({ store: store(999_999) }) }) }),
      plan({ room: blockedSite }),
    ];
    for (const result of cases) expect(result.proposals).toEqual([]);
    expect(cases.map(({ blockers }) => blockers[0]?.reason)).toEqual([
      "industry-unavailable",
      "industry-active",
      "logistics-active",
      "logistics-active",
      "logistics-unavailable",
      "logistics-active",
      "target-stocked",
      "target-unavailable",
      "replacement-pending",
      "replacement-pending",
      "replacement-pending",
      "site-conflict",
    ]);
  });

  it("migrates V16 without inventing terminal receipts and rejects spoofed legacy evidence", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    const v16 = { ...owner, schemaVersion: 16 };
    expect(parseLayoutsOwner(v16)).toEqual({ ...owner, revision: owner.revision + 1 });
    const receipt = {
      attempt: 1,
      code: "ERR_BUSY",
      nextEligibleTick: 103,
      observedAt: 100,
      replacementId: storageId,
      targetId,
      targetStructureType: "terminal",
    } as const;
    expect(
      parseLayoutsOwner({
        ...v16,
        records: [{ ...v16.records[0], removalReceipt: receipt }],
      }),
    ).toBeNull();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [{ ...owner.records[0], removalReceipt: receipt }],
      }),
    ).toEqual({ ...owner, records: [{ ...owner.records[0], removalReceipt: receipt }] });
  });
});
