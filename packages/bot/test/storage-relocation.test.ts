import { describe, expect, it, vi } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import {
  LAYOUT_ALGORITHM_REVISION,
  STRUCTURE_REMOVAL_LIMITS,
  StructureDestroyExecutor,
  arbitrateStructureRemovals,
  diffOwnedRoomLayout,
  emptyLayoutsOwner,
  layoutStorageEvacuationFlowId,
  layoutStorageEvacuationFlowIds,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutStorageEvacuation,
  reconcileStructureDestroyExecution,
  type LayoutCommitment,
  type LayoutPlacement,
} from "../src/layout";
import { ConstructionPlanner } from "../src/maintenance";
import { isLayoutLogisticsEvidenceReady } from "../src/runtime/tick";
import type { RoomSnapshot } from "../src/world/snapshot";

const roomName = "W1N1";
const pos = (x: number, y: number) => ({ roomName, x, y });
const targetId = "storage-obsolete";
const terminalId = "terminal-active";
const commitment: LayoutCommitment = {
  algorithmRevision: LAYOUT_ALGORITHM_REVISION,
  anchor: pos(25, 25),
  blockers: [],
  committedAt: 1,
  fingerprint: "layout-storage-a",
  transform: 0,
};
const storagePlacement: LayoutPlacement = {
  adoption: "planned",
  layer: "primary",
  minimumRcl: 4,
  pos: pos(20, 20),
  structureType: "storage",
};
const terminalPlacement: LayoutPlacement = {
  adoption: "exact",
  layer: "primary",
  minimumRcl: 6,
  pos: pos(21, 20),
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
const colony = {
  activeThreat: false,
  controllerRisk: false,
  id: roomName,
  legalWorkforce: true,
  rclPolicy: {
    ...projectedPolicy,
    progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
  },
  roomName,
  state: "mature",
  visibility: "visible",
} as ColonyView;

function store(capacity: number, usedCapacity = 0) {
  return {
    capacity,
    freeCapacity: capacity - usedCapacity,
    resources: usedCapacity === 0 ? [] : [{ amount: usedCapacity, resourceType: "energy" }],
    usedCapacity,
  };
}
function resourceStore(capacity: number, resources: readonly (readonly [string, number])[]) {
  const usedCapacity = resources.reduce((total, [, amount]) => total + amount, 0);
  return {
    capacity,
    freeCapacity: capacity - usedCapacity,
    resources: resources.map(([resourceType, amount]) => ({ amount, resourceType })),
    usedCapacity,
  };
}
function storage(overrides: Partial<NonNullable<RoomSnapshot["ownedStorages"]>[number]> = {}) {
  return {
    active: true,
    hits: 10_000,
    hitsMax: 10_000,
    id: targetId,
    pos: pos(30, 30),
    store: store(1_000_000),
    ...overrides,
  };
}
function terminal(overrides: Partial<NonNullable<RoomSnapshot["ownedTerminals"]>[number]> = {}) {
  return {
    active: true,
    cooldown: 0,
    hits: 3_000,
    hitsMax: 3_000,
    id: terminalId,
    pos: pos(21, 20),
    store: store(300_000, 25_000),
    ...overrides,
  };
}
function room(
  input: {
    readonly constructionSites?: RoomSnapshot["constructionSites"];
    readonly controllerLevel?: number;
    readonly extraStructures?: RoomSnapshot["structures"];
    readonly observedAt?: number;
    readonly target?: ReturnType<typeof storage> | null;
    readonly terminals?: readonly ReturnType<typeof terminal>[];
  } = {},
): RoomSnapshot {
  const target = input.target === undefined ? storage() : input.target;
  const terminals = input.terminals ?? [terminal()];
  return {
    constructionSites: input.constructionSites ?? [],
    controller: { level: input.controllerLevel ?? 8, ownership: "owned" },
    energyAvailable: 12_900,
    energyCapacityAvailable: 12_900,
    hostileCreeps: [],
    name: roomName,
    observedAt: input.observedAt ?? 100,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedStorages: target === null ? [] : [target],
    ownedTerminals: terminals,
    ownedTowers: [],
    sources: [],
    storedStructures: [],
    structures: [
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
              structureType: "storage",
            },
          ]),
      ...terminals.map((retainedTerminal) => ({
        hits: retainedTerminal.hits,
        hitsMax: retainedTerminal.hitsMax,
        id: retainedTerminal.id,
        ownerUsername: "me",
        ownership: "owned" as const,
        pos: retainedTerminal.pos,
        structureType: "terminal",
      })),
      ...(input.extraStructures ?? []),
    ],
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
    readonly activeTerminalTargetIds?: ReadonlySet<string>;
    readonly industryTerminalWork?: Parameters<
      ConstructionPlanner["planMigration"]
    >[0]["industryTerminalWork"];
    readonly labEvacuation?: Parameters<ConstructionPlanner["planMigration"]>[0]["labEvacuation"];
    readonly logisticsEvidenceReady?: boolean;
    readonly removalReceipt?: Parameters<ConstructionPlanner["planMigration"]>[0]["removalReceipt"];
    readonly room?: RoomSnapshot;
    readonly storageEvacuation?: Parameters<
      ConstructionPlanner["planMigration"]
    >[0]["storageEvacuation"];
    readonly storageRemovalCompleted?: boolean;
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
  const visibleRoom = input.room ?? room();
  return new ConstructionPlanner().planMigration({
    activeLeasedWorkTargetIds: input.activeLeasedTargetIds ?? new Set(),
    activeLogisticsEndpoints: input.activeEndpoints ?? [],
    activeLogisticsFlowIds: input.activeFlowIds ?? new Set(),
    activeLogisticsTargetIds: activeTargetIds,
    activeTerminalLogisticsTargetIds: input.activeTerminalTargetIds ?? new Set(),
    colony,
    commitment,
    globalOwnedSiteCount: 0,
    industryTerminalWork:
      "industryTerminalWork" in input
        ? (input.industryTerminalWork ?? null)
        : ({ roomName, status: "quiescent" } as const),
    labEvacuation: input.labEvacuation ?? null,
    logisticsEvidenceReady: input.logisticsEvidenceReady ?? true,
    observationFingerprint: `obs-${String(visibleRoom.observedAt)}`,
    placements: [storagePlacement, terminalPlacement],
    policyFingerprint: "policy-storage",
    removalReceipt: input.removalReceipt ?? null,
    room: visibleRoom,
    storageEvacuation: input.storageEvacuation ?? null,
    storageRemovalCompleted: input.storageRemovalCompleted ?? false,
    terminalEvacuation: input.terminalEvacuation ?? null,
  });
}

describe("empty obsolete-storage relocation", () => {
  it("requires one current healthy room Logistics projection from the enabled authority", () => {
    const currentHealth = [{ colonyId: roomName, observedAt: 100, status: "healthy" as const }];
    const ready = {
      executionStatus: "ready" as const,
      gateEnabled: true,
      health: currentHealth,
      observedAt: 100,
      planningStatus: "ready" as const,
      roomName,
    };
    expect(isLayoutLogisticsEvidenceReady(ready)).toBe(true);
    expect(isLayoutLogisticsEvidenceReady({ ...ready, gateEnabled: false })).toBe(false);
    expect(isLayoutLogisticsEvidenceReady({ ...ready, executionStatus: "unavailable" })).toBe(
      false,
    );
    expect(isLayoutLogisticsEvidenceReady({ ...ready, planningStatus: "unavailable" })).toBe(false);
    expect(isLayoutLogisticsEvidenceReady({ ...ready, health: [] })).toBe(false);
    expect(
      isLayoutLogisticsEvidenceReady({
        ...ready,
        health: [{ colonyId: roomName, observedAt: 99, status: "healthy" }],
      }),
    ).toBe(false);
    expect(
      isLayoutLogisticsEvidenceReady({
        ...ready,
        health: [{ colonyId: roomName, observedAt: 100, status: "failed" }],
      }),
    ).toBe(false);
    expect(
      isLayoutLogisticsEvidenceReady({ ...ready, health: [...currentHealth, ...currentHealth] }),
    ).toBe(false);
  });

  it("proposes and arbitrates one exact storage-to-terminal continuity removal", () => {
    const ready = plan();
    expect(ready).toMatchObject({
      blockers: [],
      proposals: [
        {
          replacementExpectedStoreCapacity: 300_000,
          replacementId: terminalId,
          replacementStructureType: "terminal",
          targetId,
          targetRequiresEmptyStore: true,
          targetStructureType: "storage",
        },
      ],
    });
    const reorderedRoom = room();
    expect(
      JSON.stringify(
        plan({
          room: {
            ...reorderedRoom,
            ownedStorages: [...(reorderedRoom.ownedStorages ?? [])].reverse(),
            ownedTerminals: [...(reorderedRoom.ownedTerminals ?? [])].reverse(),
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
        replacementExpectedStoreCapacity: 300_000,
        replacementId: terminalId,
        replacementStructureType: "terminal",
        targetId,
        targetStructureType: "storage",
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
      destroy,
      id: targetId,
      isActive: () => true,
      my: true,
      pos: pos(30, 30),
      room: liveRoom,
      store: liveStore(1_000_000, 0),
      structureType: "storage",
    } as unknown as Structure;
    const retainedTerminal = {
      id: terminalId,
      isActive: () => true,
      my: true,
      pos: pos(21, 20),
      room: liveRoom,
      store: liveStore(300_000, 25_000),
      structureType: "terminal",
    } as unknown as Structure;
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === targetId ? target : id === terminalId ? retainedTerminal : null,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK", fault: null })]);
    expect(destroy).toHaveBeenCalledOnce();

    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    owner = reconcileStructureDestroyExecution(owner, execution, 100).owner;
    expect(owner.schemaVersion).toBe(24);
    const parsed = parseLayoutsOwner(JSON.parse(JSON.stringify(owner)));
    if (parsed === null) throw new Error("expected valid storage removal receipt");
    owner = parsed;
    const receipt = owner.records[0]?.removalReceipt ?? null;
    expect(receipt).toMatchObject({ replacementId: terminalId, targetStructureType: "storage" });
    const pendingRoom = room();
    expect(
      plan({
        removalReceipt: receipt,
        room: {
          ...pendingRoom,
          structures: [...(pendingRoom.structures ?? [])].reverse(),
        },
      }).proposals,
    ).toEqual([]);
    expect(
      plan({
        removalReceipt: receipt,
        room: room({ observedAt: 100, target: null }),
      }),
    ).toMatchObject({ removalReceipt: receipt });
    expect(
      plan({
        removalReceipt: receipt,
        room: room({
          extraStructures: [
            {
              hits: 1,
              hitsMax: 1,
              id: targetId,
              ownerUsername: "me",
              ownership: "owned",
              pos: pos(30, 30),
              structureType: "road",
            },
          ],
          observedAt: 101,
          target: null,
        }),
      }),
    ).toMatchObject({ removalReceipt: receipt });
    expect(
      plan({
        removalReceipt: receipt,
        room: room({ observedAt: 101, target: null }),
      }),
    ).toMatchObject({ removalReceipt: receipt });
    expect(
      plan({
        removalReceipt: receipt,
        room: room({ observedAt: 101, target: null }),
        storageRemovalCompleted: true,
      }),
    ).toMatchObject({ removalReceipt: null });

    const finalRoom = room({ observedAt: 101, target: null });
    expect(
      diffOwnedRoomLayout({
        colonyId: roomName,
        commitment,
        commitmentConflicted: false,
        constructionSites: [],
        observationFingerprint: "obs-101",
        placements: [storagePlacement, terminalPlacement],
        policy: colony.rclPolicy,
        policyEnabled: true,
        policyFingerprint: "policy-storage",
        roomName,
        roomStatus: "owned",
        structures: finalRoom.structures ?? [],
      }).proposals,
    ).toEqual([expect.objectContaining({ pos: storagePlacement.pos, structureType: "storage" })]);
  });

  it("persists one exact bounded stocked-storage evacuation before removal", () => {
    const result = plan({ room: room({ target: storage({ store: store(1_000_000, 3_000) }) }) });

    expect(result.proposals).toEqual([]);
    expect(result.storageEvacuation).toEqual({
      amount: 3_000,
      expiresAt: 250,
      resourceType: "energy",
      sourceId: targetId,
      startedAt: 100,
      terminalId,
      terminalInitialAmount: 25_000,
    });
  });

  it("persists one fixed two-batch continuation for larger single-resource stock", () => {
    for (const amount of [3_001, 6_000]) {
      const result = plan({ room: room({ target: storage({ store: store(1_000_000, amount) }) }) });

      expect(result.proposals).toEqual([]);
      expect(result.storageEvacuation).toEqual({
        amount,
        expiresAt: 400,
        resourceType: "energy",
        settledAmount: 0,
        sourceId: targetId,
        startedAt: 100,
        terminalId,
        terminalInitialAmount: 25_000,
      });
    }
    expect(
      plan({
        room: room({
          target: storage({ store: store(1_000_000, 6_000) }),
          terminals: [terminal({ store: store(300_000, 295_000) })],
        }),
      }).storageEvacuation,
    ).toBeNull();
  });

  it("persists canonical mixed-resource terms across resource and structure reordering", () => {
    const targetResources = [
      ["energy", 2_000],
      ["H", 1_000],
    ] as const;
    const terminalResources = [
      ["energy", 25_000],
      ["H", 500],
    ] as const;
    const forward = plan({
      room: room({
        target: storage({ store: resourceStore(1_000_000, targetResources) }),
        terminals: [terminal({ store: resourceStore(300_000, terminalResources) })],
      }),
    });
    const reversed = plan({
      room: room({
        target: storage({ store: resourceStore(1_000_000, [...targetResources].reverse()) }),
        terminals: [terminal({ store: resourceStore(300_000, [...terminalResources].reverse()) })],
      }),
    });

    expect(forward.proposals).toEqual([]);
    expect(forward.storageEvacuation).toEqual({
      expiresAt: 250,
      resourceManifest: [
        ["H", 1_000, 500],
        ["energy", 2_000, 25_000],
      ],
      sourceId: targetId,
      startedAt: 100,
      terminalId,
    });
    expect(JSON.parse(JSON.stringify(reversed.storageEvacuation))).toEqual(
      JSON.parse(JSON.stringify(forward.storageEvacuation)),
    );
  });

  it("advances larger mixed stock through two deterministic batches before removal", () => {
    const minimum = plan({
      room: room({
        target: storage({
          store: resourceStore(1_000_000, [
            ["H", 1_500],
            ["energy", 1_501],
          ]),
        }),
      }),
    }).storageEvacuation;
    expect(minimum).toMatchObject({
      expiresAt: 400,
      resourceManifest: [
        ["H", 1_500, 0],
        ["energy", 1_501, 25_000],
      ],
      settledAmount: 0,
    });

    const targetResources = [
      ["H", 2_000],
      ["energy", 4_000],
    ] as const;
    const terminalResources = [
      ["H", 500],
      ["energy", 25_000],
    ] as const;
    const staged = plan({
      room: room({
        target: storage({ store: resourceStore(1_000_000, targetResources) }),
        terminals: [terminal({ store: resourceStore(300_000, terminalResources) })],
      }),
    }).storageEvacuation;
    expect(staged).toEqual({
      expiresAt: 400,
      resourceManifest: [
        ["H", 2_000, 500],
        ["energy", 4_000, 25_000],
      ],
      settledAmount: 0,
      sourceId: targetId,
      startedAt: 100,
      terminalId,
    });
    const reorderedStaged = plan({
      room: room({
        target: storage({
          store: resourceStore(1_000_000, [...targetResources].reverse()),
        }),
        terminals: [terminal({ store: resourceStore(300_000, [...terminalResources].reverse()) })],
      }),
    }).storageEvacuation;
    expect(JSON.parse(JSON.stringify(reorderedStaged))).toEqual(JSON.parse(JSON.stringify(staged)));
    if (staged === null) throw new Error("expected sequential mixed storage evacuation");
    const firstFlowIds = layoutStorageEvacuationFlowIds(roomName, staged);
    if (firstFlowIds === null) throw new Error("expected first mixed batch flows");

    const firstDelivered = room({
      observedAt: 150,
      target: storage({ store: resourceStore(1_000_000, [["energy", 3_000]]) }),
      terminals: [
        terminal({
          store: resourceStore(300_000, [
            ["H", 2_500],
            ["energy", 26_000],
          ]),
        }),
      ],
    });
    expect(
      plan({
        activeFlowIds: new Set(firstFlowIds),
        room: firstDelivered,
        storageEvacuation: staged,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-pending" })],
      storageEvacuation: staged,
    });
    const advanced = plan({ room: firstDelivered, storageEvacuation: staged });
    expect(advanced.proposals).toEqual([]);
    expect(advanced.storageEvacuation).toEqual({ ...staged, settledAmount: 3_000 });
    expect(advanced.storageEvacuation?.expiresAt).toBe(staged.expiresAt);
    expect(
      plan({
        activeEndpoints: [
          {
            counterpartId: terminalId,
            flowId: firstFlowIds[0] ?? null,
            targetId,
            version: 3,
          },
        ],
        room: firstDelivered,
        storageEvacuation: advanced.storageEvacuation,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "logistics-active" })] });
    expect(
      plan({
        room: room({
          observedAt: staged.expiresAt,
          target: storage({ store: resourceStore(1_000_000, [["energy", 3_000]]) }),
          terminals: [
            terminal({
              store: resourceStore(300_000, [
                ["H", 2_500],
                ["energy", 26_000],
              ]),
            }),
          ],
        }),
        storageEvacuation: advanced.storageEvacuation,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "evacuation-expired" })] });

    const reconstructed = parseLayoutsOwner(
      JSON.parse(
        JSON.stringify(
          persistLayoutStorageEvacuation(
            persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment),
            roomName,
            advanced.storageEvacuation,
          ),
        ),
      ),
    )?.records[0]?.storageEvacuation;
    if (reconstructed === undefined) throw new Error("expected reconstructed second mixed batch");
    const secondFlowIds = layoutStorageEvacuationFlowIds(roomName, reconstructed);
    expect(secondFlowIds).toHaveLength(1);
    expect(secondFlowIds?.[0]).not.toBe(firstFlowIds[1]);

    const delivered = room({
      observedAt: 200,
      target: storage(),
      terminals: [
        terminal({
          store: resourceStore(300_000, [
            ["H", 2_500],
            ["energy", 29_000],
          ]),
        }),
      ],
    });
    expect(
      plan({
        activeFlowIds: new Set(secondFlowIds ?? []),
        room: delivered,
        storageEvacuation: reconstructed,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "evacuation-pending" })] });
    const consumed = plan({
      room: room({
        observedAt: 200,
        target: storage(),
        terminals: [
          terminal({
            store: resourceStore(300_000, [
              ["H", 2_499],
              ["energy", 29_000],
            ]),
          }),
        ],
      }),
      storageEvacuation: reconstructed,
    });
    expect(consumed.proposals).toEqual([]);
    expect(consumed.blockers).toEqual([
      expect.objectContaining({ reason: "evacuation-incomplete" }),
    ]);

    const completed = plan({ room: delivered, storageEvacuation: reconstructed });
    expect(completed.proposals).toHaveLength(1);
    if (completed.authorization === null)
      throw new Error("expected sequential mixed removal authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [completed.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: completed.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === targetId
          ? ({
              destroy,
              id: targetId,
              isActive: () => true,
              my: true,
              pos: pos(30, 30),
              room: liveRoom,
              store: liveStore(1_000_000, 0),
              structureType: "storage",
            } as unknown as Structure)
          : id === terminalId
            ? ({
                id: terminalId,
                isActive: () => true,
                my: true,
                pos: pos(21, 20),
                room: liveRoom,
                store: liveStore(300_000, 31_500),
                structureType: "terminal",
              } as unknown as Structure)
            : null,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();

    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    owner = persistLayoutStorageEvacuation(owner, roomName, reconstructed);
    owner = reconcileStructureDestroyExecution(owner, execution, 200).owner;
    const receipt = owner.records[0]?.removalReceipt;
    if (receipt === undefined) throw new Error("expected sequential mixed removal receipt");
    expect(
      plan({ removalReceipt: receipt, room: delivered, storageEvacuation: reconstructed })
        .proposals,
    ).toEqual([]);
    const disappeared = plan({
      removalReceipt: receipt,
      room: room({ observedAt: 201, target: null }),
      storageEvacuation: reconstructed,
      storageRemovalCompleted: true,
    });
    expect(disappeared).toMatchObject({ removalReceipt: null, storageEvacuation: null });
    expect(
      diffOwnedRoomLayout({
        colonyId: roomName,
        commitment,
        commitmentConflicted: false,
        constructionSites: [],
        observationFingerprint: "obs-201",
        placements: [storagePlacement, terminalPlacement],
        policy: colony.rclPolicy,
        policyEnabled: true,
        policyFingerprint: "policy-storage",
        roomName,
        roomStatus: "owned",
        structures: room({ observedAt: 201, target: null }).structures ?? [],
      }).proposals,
    ).toEqual([expect.objectContaining({ pos: storagePlacement.pos, structureType: "storage" })]);
  });

  it("rejects over-kind, over-total, and aggregate terminal-capacity mixed stock", () => {
    const overKinds = Array.from({ length: 9 }, (_, index) => [`R${String(index)}`, 1] as const);
    const overTotal = [
      ["H", 3_000],
      ["energy", 3_001],
    ] as const;
    const noCapacity = [
      ["H", 1_000],
      ["energy", 2_000],
    ] as const;
    for (const result of [
      plan({ room: room({ target: storage({ store: resourceStore(1_000_000, overKinds) }) }) }),
      plan({ room: room({ target: storage({ store: resourceStore(1_000_000, overTotal) }) }) }),
      plan({
        room: room({
          target: storage({ store: resourceStore(1_000_000, noCapacity) }),
          terminals: [terminal({ store: store(300_000, 298_000) })],
        }),
      }),
    ]) {
      expect(result.proposals).toEqual([]);
      expect(result.storageEvacuation).toBeNull();
    }
  });

  it("resumes a mixed evacuation and waits for every flow and endpoint to retire", () => {
    const staged = plan({
      room: room({
        target: storage({
          store: resourceStore(1_000_000, [
            ["H", 1_000],
            ["energy", 2_000],
          ]),
        }),
        terminals: [
          terminal({
            store: resourceStore(300_000, [
              ["H", 500],
              ["energy", 25_000],
            ]),
          }),
        ],
      }),
    }).storageEvacuation;
    if (staged === null) throw new Error("expected mixed storage evacuation");
    const flowIds = layoutStorageEvacuationFlowIds(roomName, staged);
    if (flowIds === null) throw new Error("expected bounded mixed storage flows");
    const partiallyDelivered = room({
      observedAt: 101,
      target: storage({ store: resourceStore(1_000_000, [["energy", 2_000]]) }),
      terminals: [
        terminal({
          store: resourceStore(300_000, [
            ["H", 1_500],
            ["energy", 25_000],
          ]),
        }),
      ],
    });
    let resetOwner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    resetOwner = persistLayoutStorageEvacuation(resetOwner, roomName, staged);
    const reconstructedOwner = parseLayoutsOwner(JSON.parse(JSON.stringify(resetOwner)));
    const reconstructed = reconstructedOwner?.records[0]?.storageEvacuation;
    if (reconstructed === undefined) throw new Error("expected reconstructed mixed evacuation");
    expect(
      plan({
        activeFlowIds: new Set([flowIds[1] as string]),
        room: partiallyDelivered,
        storageEvacuation: reconstructed,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "target-stocked" })] });

    const delivered = room({
      observedAt: 102,
      target: storage(),
      terminals: [
        terminal({
          store: resourceStore(300_000, [
            ["energy", 27_000],
            ["H", 1_500],
          ]),
        }),
      ],
    });
    expect(
      plan({
        activeFlowIds: new Set([flowIds[1] as string]),
        room: delivered,
        storageEvacuation: staged,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "evacuation-pending" })] });
    const completed = plan({ room: delivered, storageEvacuation: staged });
    expect(completed.proposals).toHaveLength(1);
    expect(completed.proposals[0]?.stableId).toContain("remove-storage-v2");
    if (completed.authorization === null) throw new Error("expected mixed removal authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [completed.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: completed.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === targetId
          ? ({
              destroy,
              id: targetId,
              isActive: () => true,
              my: true,
              pos: pos(30, 30),
              room: liveRoom,
              store: liveStore(1_000_000, 0),
              structureType: "storage",
            } as unknown as Structure)
          : id === terminalId
            ? ({
                id: terminalId,
                isActive: () => true,
                my: true,
                pos: pos(21, 20),
                room: liveRoom,
                store: liveStore(300_000, 28_500),
                structureType: "terminal",
              } as unknown as Structure)
            : null,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();

    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    owner = persistLayoutStorageEvacuation(owner, roomName, staged);
    owner = reconcileStructureDestroyExecution(owner, execution, 102).owner;
    const receipt = owner.records[0]?.removalReceipt;
    if (receipt === undefined) throw new Error("expected mixed removal receipt");
    expect(
      plan({ removalReceipt: receipt, room: delivered, storageEvacuation: staged }).proposals,
    ).toEqual([]);
    const disappeared = plan({
      removalReceipt: receipt,
      room: room({ observedAt: 103, target: null }),
      storageEvacuation: staged,
      storageRemovalCompleted: true,
    });
    expect(disappeared).toMatchObject({ removalReceipt: null, storageEvacuation: null });
    const finalRoom = room({ observedAt: 103, target: null });
    expect(
      diffOwnedRoomLayout({
        colonyId: roomName,
        commitment,
        commitmentConflicted: false,
        constructionSites: [],
        observationFingerprint: "obs-103",
        placements: [storagePlacement, terminalPlacement],
        policy: colony.rclPolicy,
        policyEnabled: true,
        policyFingerprint: "policy-storage",
        roomName,
        roomStatus: "owned",
        structures: finalRoom.structures ?? [],
      }).proposals,
    ).toEqual([expect.objectContaining({ pos: storagePlacement.pos, structureType: "storage" })]);
  });

  it("advances exactly once after first-batch delivery and work retirement", () => {
    const staged = plan({
      room: room({ target: storage({ store: store(1_000_000, 6_000) }) }),
    }).storageEvacuation;
    if (staged === null || !("settledAmount" in staged))
      throw new Error("expected sequential storage evacuation");
    const firstFlowId = layoutStorageEvacuationFlowId(roomName, staged);
    if (firstFlowId === null) throw new Error("expected first batch flow");
    const firstDelivered = room({
      observedAt: 150,
      target: storage({ store: store(1_000_000, 3_000) }),
      terminals: [terminal({ store: store(300_000, 28_000) })],
    });

    expect(
      plan({
        activeFlowIds: new Set([firstFlowId]),
        room: firstDelivered,
        storageEvacuation: staged,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-pending" })],
      storageEvacuation: staged,
    });
    expect(
      plan({
        activeTargetIds: new Set([targetId, terminalId]),
        room: firstDelivered,
        storageEvacuation: staged,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "logistics-active" })],
      storageEvacuation: staged,
    });
    const advanced = plan({ room: firstDelivered, storageEvacuation: staged });
    expect(advanced.proposals).toEqual([]);
    expect(advanced.blockers).toEqual([expect.objectContaining({ reason: "evacuation-pending" })]);
    expect(advanced.storageEvacuation).toEqual({ ...staged, settledAmount: 3_000 });
    const reorderedFirstDelivered = {
      ...firstDelivered,
      ownedStorages: [...(firstDelivered.ownedStorages ?? [])].reverse(),
      ownedTerminals: [...(firstDelivered.ownedTerminals ?? [])].reverse(),
      storedStructures: [...firstDelivered.storedStructures].reverse(),
      structures: [...(firstDelivered.structures ?? [])].reverse(),
    };
    expect(
      plan({
        room: reorderedFirstDelivered,
        storageEvacuation: JSON.parse(JSON.stringify(staged)) as typeof staged,
      }).storageEvacuation,
    ).toEqual(advanced.storageEvacuation);
    expect(
      plan({
        room: room({
          observedAt: staged.expiresAt,
          target: storage({ store: store(1_000_000, 3_000) }),
          terminals: [terminal({ store: store(300_000, 28_000) })],
        }),
        storageEvacuation: staged,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-expired" })],
      storageEvacuation: staged,
    });
    expect(
      plan({
        room: room({
          observedAt: 151,
          target: storage(),
          terminals: [terminal({ store: store(300_000, 31_000) })],
        }),
        storageEvacuation: staged,
      }).proposals,
    ).toEqual([]);

    const reconstructed = parseLayoutsOwner(
      JSON.parse(
        JSON.stringify(
          persistLayoutStorageEvacuation(
            persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment),
            roomName,
            advanced.storageEvacuation,
          ),
        ),
      ),
    )?.records[0]?.storageEvacuation;
    if (reconstructed === undefined) throw new Error("expected reconstructed second batch");
    const secondFlowId = layoutStorageEvacuationFlowId(roomName, reconstructed);
    expect(secondFlowId).not.toBe(firstFlowId);

    const delivered = room({
      observedAt: 200,
      target: storage(),
      terminals: [terminal({ store: store(300_000, 31_000) })],
    });
    expect(
      plan({
        activeFlowIds: new Set([secondFlowId as string]),
        room: delivered,
        storageEvacuation: reconstructed,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "evacuation-pending" })] });
    const completed = plan({ room: delivered, storageEvacuation: reconstructed });
    expect(completed.proposals).toHaveLength(1);
    if (completed.authorization === null)
      throw new Error("expected sequential removal authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [completed.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: completed.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === targetId
          ? ({
              destroy,
              id: targetId,
              isActive: () => true,
              my: true,
              pos: pos(30, 30),
              room: liveRoom,
              store: liveStore(1_000_000, 0),
              structureType: "storage",
            } as unknown as Structure)
          : id === terminalId
            ? ({
                id: terminalId,
                isActive: () => true,
                my: true,
                pos: pos(21, 20),
                room: liveRoom,
                store: liveStore(300_000, 31_000),
                structureType: "terminal",
              } as unknown as Structure)
            : null,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();

    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    owner = persistLayoutStorageEvacuation(owner, roomName, reconstructed);
    owner = reconcileStructureDestroyExecution(owner, execution, 200).owner;
    const receipt = owner.records[0]?.removalReceipt;
    if (receipt === undefined) throw new Error("expected sequential removal receipt");
    expect(
      plan({ removalReceipt: receipt, room: delivered, storageEvacuation: reconstructed })
        .proposals,
    ).toEqual([]);
    const disappeared = plan({
      removalReceipt: receipt,
      room: room({ observedAt: 201, target: null }),
      storageEvacuation: reconstructed,
      storageRemovalCompleted: true,
    });
    expect(disappeared).toMatchObject({ removalReceipt: null, storageEvacuation: null });
    expect(
      diffOwnedRoomLayout({
        colonyId: roomName,
        commitment,
        commitmentConflicted: false,
        constructionSites: [],
        observationFingerprint: "obs-201",
        placements: [storagePlacement, terminalPlacement],
        policy: colony.rclPolicy,
        policyEnabled: true,
        policyFingerprint: "policy-storage",
        roomName,
        roomStatus: "owned",
        structures: room({ observedAt: 201, target: null }).structures ?? [],
      }).proposals,
    ).toEqual([expect.objectContaining({ pos: storagePlacement.pos, structureType: "storage" })]);
  });

  it("resumes partial evacuation and waits for exact work retirement before removal", () => {
    const staged = plan({
      room: room({ target: storage({ store: store(1_000_000, 3_000) }) }),
    }).storageEvacuation;
    if (staged === null) throw new Error("expected storage evacuation");
    const flowId = layoutStorageEvacuationFlowId(roomName, staged);
    if (flowId === null) throw new Error("expected bounded storage flow");

    expect(
      plan({
        activeFlowIds: new Set([flowId]),
        room: room({
          observedAt: 101,
          target: storage({ store: store(1_000_000, 1_500) }),
          terminals: [terminal({ store: store(300_000, 26_500) })],
        }),
        storageEvacuation: staged,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "target-stocked" })] });

    const deliveredRoom = room({
      observedAt: 102,
      target: storage(),
      terminals: [terminal({ store: store(300_000, 28_000) })],
    });
    expect(
      plan({
        activeFlowIds: new Set([flowId]),
        activeTargetIds: new Set([targetId, terminalId]),
        room: deliveredRoom,
        storageEvacuation: staged,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "evacuation-pending" })] });
    expect(
      plan({
        activeTargetIds: new Set([targetId, terminalId]),
        room: deliveredRoom,
        storageEvacuation: staged,
      }),
    ).toMatchObject({ blockers: [expect.objectContaining({ reason: "logistics-active" })] });
    const completed = plan({ room: deliveredRoom, storageEvacuation: staged });
    expect(completed).toMatchObject({
      blockers: [],
      storageEvacuation: staged,
    });
    expect(completed.proposals).toHaveLength(1);
    expect(completed.proposals[0]?.stableId).toContain("remove-storage-v2");
    if (completed.authorization === null) throw new Error("expected stocked authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [completed.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: completed.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === targetId
          ? ({
              destroy,
              id: targetId,
              isActive: () => true,
              my: true,
              pos: pos(30, 30),
              room: liveRoom,
              store: liveStore(1_000_000, 0),
              structureType: "storage",
            } as unknown as Structure)
          : id === terminalId
            ? ({
                id: terminalId,
                isActive: () => true,
                my: true,
                pos: pos(21, 20),
                room: liveRoom,
                store: liveStore(300_000, 28_000),
                structureType: "terminal",
              } as unknown as Structure)
            : null,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();
    const successReceipt = {
      attempt: 1,
      code: "OK",
      nextEligibleTick: 104,
      observedAt: 102,
      replacementId: terminalId,
      targetId,
      targetStructureType: "storage",
    } as const;
    expect(
      plan({
        removalReceipt: successReceipt,
        room: deliveredRoom,
        storageEvacuation: staged,
      }).proposals,
    ).toEqual([]);

    expect(
      plan({
        removalReceipt: successReceipt,
        room: room({ observedAt: 103, target: null }),
        storageEvacuation: staged,
      }),
    ).toMatchObject({ removalReceipt: successReceipt, storageEvacuation: staged });
    const disappeared = plan({
      removalReceipt: successReceipt,
      room: room({ observedAt: 103, target: null }),
      storageEvacuation: staged,
      storageRemovalCompleted: true,
    });
    expect(disappeared).toMatchObject({ removalReceipt: null, storageEvacuation: null });

    const expired = plan({
      room: room({
        observedAt: staged.expiresAt,
        target: storage({ store: store(1_000_000, 3_000) }),
      }),
      storageEvacuation: staged,
    });
    expect(expired).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-expired" })],
      proposals: [],
      storageEvacuation: staged,
    });
  });

  it("fails closed for target, terminal, work, durable destination, and site drift", () => {
    const otherTerminal = terminal({ id: "terminal-other", pos: pos(40, 40) });
    const blockedSiteRoom = room({
      extraStructures: [
        {
          hits: 1_000,
          hitsMax: 1_000,
          id: "factory-blocking-storage",
          ownerUsername: "me",
          ownership: "owned",
          pos: storagePlacement.pos,
          structureType: "factory",
        },
      ],
    });
    const endpoint = { counterpartId: targetId, flowId: "flow", targetId: "creep", version: 3 };
    const cases = [
      plan({ room: room({ controllerLevel: 5 }) }),
      plan({ room: room({ target: storage({ active: false }) }) }),
      plan({ room: room({ target: storage({ store: store(1_000_000, 1) }) }) }),
      plan({ room: room({ target: storage({ store: store(999_999) }) }) }),
      plan({
        room: room({
          target: storage({
            store: {
              capacity: 1_000_000,
              freeCapacity: 999_998,
              resources: [
                { amount: 1, resourceType: "H" },
                { amount: 1, resourceType: "O" },
              ],
              usedCapacity: 2,
            },
          }),
        }),
      }),
      plan({ room: room({ target: storage({ store: store(1_000_000, 6_001) }) }) }),
      plan({
        room: room({
          target: storage({ store: store(1_000_000, 3_000) }),
          terminals: [terminal({ store: store(300_000, 298_000) })],
        }),
      }),
      plan({
        industryTerminalWork: { roomName, status: "active" },
        room: room({ target: storage({ store: store(1_000_000, 3_000) }) }),
      }),
      plan({
        industryTerminalWork: null,
        room: room({ target: storage({ store: store(1_000_000, 3_000) }) }),
      }),
      plan({ room: room({ terminals: [] }) }),
      plan({ room: room({ terminals: [terminal({ active: false })] }) }),
      plan({ room: room({ terminals: [terminal({ store: store(299_999) })] }) }),
      plan({ room: room({ terminals: [terminal(), otherTerminal] }) }),
      plan({ logisticsEvidenceReady: false }),
      plan({ activeLeasedTargetIds: new Set([targetId]) }),
      plan({ activeTargetIds: new Set([targetId]) }),
      plan({ activeEndpoints: [endpoint] }),
      plan({
        activeTerminalTargetIds: new Set([terminalId]),
        room: room({ target: storage({ store: store(1_000_000, 3_000) }) }),
      }),
      plan({
        labEvacuation: {
          amount: 100,
          destinationId: targetId,
          destinationInitialAmount: 0,
          expiresAt: 250,
          replacementId: "lab-retained",
          resourceType: "H",
          sourceId: "lab-obsolete",
          startedAt: 100,
        },
      }),
      plan({
        labEvacuation: {
          amount: 100,
          destinationId: terminalId,
          destinationInitialAmount: 0,
          destinationStructureType: "terminal",
          expiresAt: 250,
          replacementId: "lab-retained",
          resourceType: "H",
          sourceId: "lab-obsolete",
          startedAt: 100,
        },
        room: room({ target: storage({ store: store(1_000_000, 3_000) }) }),
      }),
      plan({
        terminalEvacuation: {
          amount: 100,
          expiresAt: 250,
          replacementId: targetId,
          replacementInitialAmount: 0,
          resourceType: "energy",
          sourceId: "terminal-obsolete",
          startedAt: 100,
        },
      }),
      plan({ room: blockedSiteRoom }),
    ];
    for (const result of cases) expect(result.proposals).toEqual([]);
    expect(cases[2]?.storageEvacuation).not.toBeNull();
    expect(cases[4]?.storageEvacuation).not.toBeNull();
    for (const [index, result] of cases.entries())
      if (index !== 2 && index !== 4) expect(result.storageEvacuation).toBeNull();
    expect(cases.map(({ blockers }) => blockers[0]?.reason)).toEqual([
      "replacement-pending",
      "target-unavailable",
      "target-stocked",
      "target-unavailable",
      "target-stocked",
      "target-stocked",
      "evacuation-capacity",
      "industry-active",
      "industry-unavailable",
      "replacement-pending",
      "replacement-pending",
      "replacement-pending",
      "replacement-pending",
      "logistics-unavailable",
      "logistics-active",
      "logistics-active",
      "logistics-active",
      "logistics-active",
      "logistics-active",
      "logistics-active",
      "logistics-active",
      "site-conflict",
    ]);

    expect(plan({ room: room({ terminals: [terminal({ cooldown: 1 })] }) }).proposals).toHaveLength(
      1,
    );
  });

  it("migrates V19 without inventing storage receipts and rejects spoofed legacy evidence", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment);
    const v19 = { ...owner, schemaVersion: 19 };
    expect(parseLayoutsOwner(v19)).toEqual({
      ...owner,
      revision: owner.revision + 1,
    });
    const receipt = {
      attempt: 1,
      code: "ERR_BUSY",
      nextEligibleTick: 103,
      observedAt: 100,
      replacementId: terminalId,
      targetId,
      targetStructureType: "storage",
    } as const;
    expect(
      parseLayoutsOwner({
        ...v19,
        records: [{ ...v19.records[0], removalReceipt: receipt }],
      }),
    ).toBeNull();
    expect(
      parseLayoutsOwner({
        ...owner,
        schemaVersion: 20,
        records: [{ ...owner.records[0], removalReceipt: receipt }],
      }),
    ).toEqual({
      ...owner,
      revision: owner.revision + 1,
      records: [{ ...owner.records[0], removalReceipt: receipt }],
    });
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [{ ...owner.records[0], removalReceipt: receipt }],
      }),
    ).toEqual({ ...owner, records: [{ ...owner.records[0], removalReceipt: receipt }] });
  });

  it("rejects malformed cross-type authority and freshly revalidates both live stores", () => {
    const ready = plan();
    if (ready.authorization === null || ready.proposals[0] === undefined)
      throw new Error("expected storage proposal");
    for (const malformed of [
      { ...ready.proposals[0], replacementExpectedStoreCapacity: 299_999 },
      { ...ready.proposals[0], replacementStructureType: "storage" },
      { ...ready.proposals[0], targetStructureType: "terminal" },
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
    if (intent === undefined) throw new Error("expected storage intent");
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveStore = (capacity: number, used: number) => ({
      getCapacity: () => capacity,
      getFreeCapacity: () => capacity - used,
      getUsedCapacity: () => used,
    });
    const target = (capacity = 1_000_000, used = 0) =>
      ({
        destroy: vi.fn(() => 0),
        id: targetId,
        isActive: () => true,
        my: true,
        pos: pos(30, 30),
        room: liveRoom,
        store: liveStore(capacity, used),
        structureType: "storage",
      }) as unknown as Structure;
    const retainedTerminal = (capacity = 300_000) =>
      ({
        id: terminalId,
        isActive: () => true,
        my: true,
        pos: pos(21, 20),
        room: liveRoom,
        store: liveStore(capacity, 25_000),
        structureType: "terminal",
      }) as unknown as Structure;
    const execute = (storage: Structure, terminal: Structure | null) =>
      new StructureDestroyExecutor().execute([intent], {
        hasCurrentHostiles: () => false,
        isCurrentCommitment: () => true,
        resolveRoom: () => liveRoom,
        resolveStructure: (id) => (id === targetId ? storage : id === terminalId ? terminal : null),
      })[0];

    expect(execute(target(999_999), retainedTerminal())).toMatchObject({
      called: false,
      fault: "target-not-empty",
    });
    expect(execute(target(1_000_000, 1), retainedTerminal())).toMatchObject({
      called: false,
      fault: "target-not-empty",
    });
    expect(execute(target(), retainedTerminal(299_999))).toMatchObject({
      called: false,
      fault: "replacement-store-mismatch",
    });
    expect(execute(target(), null)).toMatchObject({
      called: false,
      fault: "replacement-absent",
    });
  });
});
