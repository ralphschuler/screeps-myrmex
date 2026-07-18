import { describe, expect, it } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import { ConstructionPlanner, DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY } from "../src/maintenance";
import type { LayoutCommitment, LayoutPlacement } from "../src/layout";
import type { RoomSnapshot, StructureSnapshot, WorldSnapshot } from "../src/world/snapshot";

describe("ConstructionPlanner", () => {
  it("prioritizes critical layout flows before ordinary damage deterministically", () => {
    const first = plan(world());
    const reordered = plan(world(true));
    expect(first.proposals.map(({ targetId }) => targetId)).toEqual([
      "road-critical",
      "container-a",
      "spawn-a",
      "road-unused",
    ]);
    expect(reordered).toEqual(first);
    expect(first.health).toEqual([{ colonyId: "W1N1", observedAt: 100, status: "healthy" }]);
    expect(first.proposals[0]).toMatchObject({
      layoutPlanned: true,
      reason: "critical-flow-decay",
      towerEligible: true,
      trafficScore: 100,
    });
  });

  it("keeps fortification bounded by RCL, reserve, and explicit threat policy", () => {
    const protectedResult = plan(world(), "protected");
    expect(protectedResult.proposals.some(({ structureClass }) => structureClass === "wall")).toBe(
      false,
    );
    expect(protectedResult.deferred).toContainEqual({
      reason: "protected-reserve",
      targetId: "wall-a",
    });

    const surplus = plan(fortificationWorld(), "surplus");
    expect(surplus.proposals.find(({ targetId }) => targetId === "wall-a")?.targetHits).toBe(
      200_000,
    );
    const threatened = plan(fortificationWorld(true), "surplus");
    expect(threatened.proposals.find(({ targetId }) => targetId === "wall-a")?.targetHits).toBe(
      400_000,
    );
    expect(threatened.proposals.every(({ towerEligible }) => !towerEligible)).toBe(true);
  });

  it("caps scans, proposals, energy, and deferred detail while retaining aggregate counts", () => {
    const policy = {
      ...DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY,
      maximumDeferredRecords: 1,
      maximumEnergyPerRoom: 1,
      maximumEnergyPerTarget: 1,
      maximumProposalsPerRoom: 1,
      maximumScannedStructuresPerRoom: 3,
    };
    const result = new ConstructionPlanner().plan({
      layouts: layouts(),
      policy,
      reserves: [{ roomName: "W1N1", state: "surplus" }],
      snapshot: world(),
      traffic: [{ score: 100, targetId: "road-critical" }],
    });
    expect(result.scannedStructures).toBe(3);
    expect(result.truncatedStructures).toBeGreaterThan(0);
    expect(result.proposals).toHaveLength(1);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferredCount).toBeGreaterThan(result.deferred.length);
    expect(result.health).toEqual([{ colonyId: "W1N1", observedAt: 100, status: "failed" }]);
  });

  it("retires destroyed or satisfied targets by recomputing from current observation after reset", () => {
    const original = plan(world());
    const changed = world();
    const room = changed.rooms[0];
    if (room === undefined) throw new Error("room missing");
    const snapshot = {
      ...changed,
      rooms: [
        {
          ...room,
          structures: (room.structures ?? []).filter(({ id }) => id !== "spawn-a"),
          roads: [],
        },
      ],
    };
    const reset = plan(snapshot);
    expect(original.proposals.some(({ targetId }) => targetId === "spawn-a")).toBe(true);
    expect(reset.proposals.some(({ targetId }) => targetId === "spawn-a")).toBe(false);
    expect(reset.proposals.some(({ structureClass }) => structureClass === "road")).toBe(false);
  });

  it("proposes only the road solely blocking an unlocked planned tower", () => {
    const first = planMigration();
    const reordered = planMigration({
      placements: [...migrationPlacements()].reverse(),
      room: {
        ...migrationRoom(),
        structures: [...(migrationRoom().structures ?? [])].reverse(),
      },
    });

    expect(first.authorization).toMatchObject({
      colonyId: "W1N1",
      layoutFingerprint: "layout-migration-a",
      observationFingerprint: "observation-a",
      policyFingerprint: "policy-a",
      roomName: "W1N1",
    });
    expect(first.proposals).toEqual([
      expect.objectContaining({
        replacementStructureType: "tower",
        targetId: "road-blocker",
        targetStructureType: "road",
      }),
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
  });

  it("fails temporary-road migration closed under colony, threat, reserve, and site pressure", () => {
    const unsafeColonies: ColonyView[] = [
      migrationColony({ state: "recovering" }),
      migrationColony({ activeThreat: true }),
      migrationColony({ controllerRisk: true }),
      migrationColony({ legalWorkforce: false }),
      migrationColony({ visibility: "unknown" }),
      migrationColony({ reserveState: "unrestored" }),
    ];
    for (const colony of unsafeColonies) {
      const result = planMigration({ colony });
      expect(result.authorization, colony.state).toBeNull();
      expect(result.proposals, colony.state).toEqual([]);
    }
    expect(
      planMigration({
        room: { ...migrationRoom(), hostileCreeps: [{}] } as unknown as RoomSnapshot,
      }).proposals,
    ).toEqual([]);
    expect(planMigration({ globalOwnedSiteCount: 95 }).proposals).toEqual([]);
    expect(
      planMigration({
        room: {
          ...migrationRoom(),
          constructionSites: Array.from({ length: 10 }, (_, index) => ({
            id: `site-${String(index)}`,
            ownerUsername: "me",
            ownership: "owned" as const,
            pos: { roomName: "W1N1", x: index, y: 1 },
            progress: 0,
            progressTotal: 100,
            structureType: "road",
          })),
        },
      }).proposals,
    ).toEqual([]);
  });

  it("never proposes non-road, multiply occupied, site-conflicted, or over-allowance removal", () => {
    const base = migrationRoom();
    for (const structures of [
      [structure("spawn-blocker", "spawn", 5_000, 5_000, 15, 15)],
      [
        structure("road-blocker", "road", 5_000, 5_000, 15, 15),
        structure("rampart-blocker", "rampart", 5_000, 5_000, 15, 15),
      ],
    ])
      expect(planMigration({ room: { ...base, structures } as RoomSnapshot }).proposals).toEqual(
        [],
      );
    expect(
      planMigration({
        room: {
          ...base,
          constructionSites: [
            {
              id: "site-blocker",
              ownerUsername: "me",
              ownership: "owned",
              pos: { roomName: "W1N1", x: 15, y: 15 },
              progress: 0,
              progressTotal: 100,
              structureType: "road",
            },
          ],
        },
      }).proposals,
    ).toEqual([]);
    expect(
      planMigration({
        room: {
          ...base,
          structures: [
            ...(base.structures ?? []),
            structure("tower-existing", "tower", 3_000, 3_000, 1, 2),
          ],
        } as RoomSnapshot,
      }).proposals,
    ).toEqual([]);
  });

  it("preserves the exact source service while proposing one empty redundant container", () => {
    const { placements, room } = sourceContainerMigrationFixture();
    const first = planMigration({ placements, room });
    const reordered = planMigration({
      placements: [...placements].reverse(),
      room: {
        ...room,
        sources: [...room.sources].reverse(),
        storedStructures: [...room.storedStructures].reverse(),
        structures: [...(room.structures ?? [])].reverse(),
      },
    });
    const reset = planMigration(
      JSON.parse(JSON.stringify({ placements, room })) as Pick<
        Parameters<ConstructionPlanner["planMigration"]>[0],
        "placements" | "room"
      >,
    );

    expect(first.proposals).toEqual([
      expect.objectContaining({
        replacementId: "container-service",
        replacementStructureType: "container",
        targetId: "container-redundant",
        targetRequiresEmptyStore: true,
        targetStructureType: "container",
      }),
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
    expect(JSON.stringify(reset)).toBe(JSON.stringify(first));
  });

  it("keeps unsafe, stocked, selected, shared, and replacementless containers", () => {
    const fixture = sourceContainerMigrationFixture();
    const target = fixture.room.storedStructures.find(({ id }) => id === "container-redundant");
    if (target === undefined) throw new Error("target missing");
    const replacement = fixture.room.storedStructures.find(({ id }) => id === "container-service");
    if (replacement === undefined) throw new Error("replacement missing");
    const cases: Partial<Parameters<ConstructionPlanner["planMigration"]>[0]>[] = [
      {
        room: {
          ...fixture.room,
          controller: { ...fixture.room.controller, ownership: "foreign" },
        } as RoomSnapshot,
      },
      {
        room: {
          ...fixture.room,
          storedStructures: [
            sourceContainer(target.id, target.pos.x, target.pos.y, 1),
            replacement,
          ],
        },
      },
      {
        placements: [
          {
            ...fixture.placements[0],
            pos: target.pos,
          } as LayoutPlacement,
        ],
      },
      {
        room: {
          ...fixture.room,
          structures: [
            ...(fixture.room.structures ?? []),
            structure(
              "rampart-shared",
              "rampart",
              5_000,
              5_000,
              target.pos.x,
              target.pos.y,
            ) as StructureSnapshot,
          ],
        },
      },
      {
        room: {
          ...fixture.room,
          constructionSites: [
            {
              id: "site-shared",
              ownerUsername: "me",
              ownership: "owned",
              pos: target.pos,
              progress: 0,
              progressTotal: 5_000,
              structureType: "container",
            },
          ],
        },
      },
      {
        placements: fixture.placements.map((placement) => ({
          ...placement,
          adoption: "planned" as const,
        })),
      },
      {
        room: {
          ...fixture.room,
          storedStructures: [target],
          structures: [target],
        },
      },
    ];
    for (const value of cases)
      expect(
        planMigration({ placements: fixture.placements, room: fixture.room, ...value }).proposals,
      ).toEqual([]);
  });
});

function plan(snapshot: WorldSnapshot, state: "protected" | "surplus" = "surplus") {
  return new ConstructionPlanner().plan({
    layouts: layouts(),
    reserves: [{ roomName: "W1N1", state }],
    snapshot,
    traffic: [{ score: 100, targetId: "road-critical" }],
  });
}

function world(reordered = false, hostile = false): WorldSnapshot {
  const structures = [
    structure("spawn-a", "spawn", 1_000, 5_000, 10, 10),
    structure("wall-a", "constructedWall", 1, 300_000_000, 20, 20),
    structure("rampart-a", "rampart", 1, 300_000_000, 21, 20, 500, false),
  ];
  const roads = [
    { ...structure("road-critical", "road", 1_000, 5_000, 11, 10), ticksToDecay: 500 },
    { ...structure("road-unused", "road", 1_000, 5_000, 40, 40), ticksToDecay: 500 },
  ];
  const container = {
    ...structure("container-a", "container", 1_000, 250_000, 12, 10, 500),
    store: { capacity: 2_000, freeCapacity: 2_000, resources: [], usedCapacity: 0 },
  };
  const room = {
    constructionSites: [],
    controller: { level: 6, ownership: "owned" },
    hostileCreeps: hostile ? [{}] : [],
    name: "W1N1",
    observedAt: 100,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    roads: reordered ? roads.slice().reverse() : roads,
    sources: [],
    storedStructures: [container],
    structures: reordered ? structures.slice().reverse() : structures,
  };
  return { observation: { shard: "shard0", tick: 100 }, rooms: [room] } as unknown as WorldSnapshot;
}

function fortificationWorld(hostile = false): WorldSnapshot {
  const snapshot = world(false, hostile);
  const room = snapshot.rooms[0];
  if (room === undefined) throw new Error("room missing");
  return {
    ...snapshot,
    rooms: [
      {
        ...room,
        roads: [],
        storedStructures: [],
        structures: (room.structures ?? []).filter(({ structureType }) =>
          ["constructedWall", "rampart"].includes(structureType),
        ),
      },
    ],
  };
}

function structure(
  id: string,
  structureType: string,
  hits: number,
  hitsMax: number,
  x: number,
  y: number,
  ticksToDecay: number | null = null,
  isPublic: boolean | null = null,
) {
  return {
    hits,
    hitsMax,
    id,
    isPublic,
    ownerUsername: structureType === "road" || structureType === "constructedWall" ? null : "me",
    ownership:
      structureType === "road" || structureType === "constructedWall" ? "unowned" : "owned",
    pos: { roomName: "W1N1", x, y },
    structureType,
    ticksToDecay,
  };
}
function sourceContainer(id: string, x: number, y: number, usedCapacity: number) {
  return {
    ...structure(id, "container", 250_000, 250_000, x, y, 500),
    ownerUsername: null,
    ownership: "unowned" as const,
    store: {
      capacity: 2_000,
      freeCapacity: 2_000 - usedCapacity,
      resources: usedCapacity === 0 ? [] : [{ amount: usedCapacity, resourceType: "energy" }],
      usedCapacity,
    },
  };
}
function sourceContainerMigrationFixture(): {
  readonly placements: readonly LayoutPlacement[];
  readonly room: RoomSnapshot;
} {
  const replacement = sourceContainer("container-service", 11, 10, 500);
  const target = sourceContainer("container-redundant", 10, 11, 0);
  return {
    placements: [
      {
        adoption: "exact",
        layer: "primary",
        minimumRcl: 2,
        pos: replacement.pos,
        service: { kind: "source-container", sourceId: "source-a" },
        structureType: "container",
      },
    ],
    room: {
      ...migrationRoom(),
      sources: [
        {
          energy: 3_000,
          energyCapacity: 3_000,
          id: "source-a",
          pos: { roomName: "W1N1", x: 10, y: 10 },
          ticksToRegeneration: null,
        },
      ],
      storedStructures: [target, replacement],
      structures: [target, replacement],
    },
  };
}

function layouts(): ReadonlyMap<string, readonly LayoutPlacement[]> {
  return new Map([
    [
      "W1N1",
      [placement("road", 11, 10), placement("container", 12, 10), placement("spawn", 10, 10)],
    ],
  ]);
}
function placement(structureType: string, x: number, y: number): LayoutPlacement {
  return {
    adoption: "planned",
    layer: structureType === "road" ? "road" : "primary",
    minimumRcl: 1,
    pos: { roomName: "W1N1", x, y },
    structureType,
  };
}

const migrationCommitment: LayoutCommitment = {
  algorithmRevision: "owned-room-layout-v2-source-services",
  anchor: { roomName: "W1N1", x: 25, y: 25 },
  blockers: [],
  committedAt: 1,
  fingerprint: "layout-migration-a",
  transform: 0,
};
function migrationPlacements(): readonly LayoutPlacement[] {
  return [placement("road", 14, 15), placement("tower", 15, 15)];
}
function migrationRoom(): RoomSnapshot {
  return {
    constructionSites: [],
    controller: { level: 3, ownership: "owned" },
    hostileCreeps: [],
    name: "W1N1",
    observedAt: 100,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedSpawns: [],
    ownedTowers: [],
    roads: [],
    sources: [],
    storedStructures: [],
    structures: [
      structure("road-blocker", "road", 5_000, 5_000, 15, 15),
      ...Array.from({ length: 10 }, (_, index) =>
        structure(`extension-${String(index)}`, "extension", 1_000, 1_000, index, 2),
      ),
    ],
  } as unknown as RoomSnapshot;
}
function migrationColony(
  overrides: Partial<ColonyView> & { readonly reserveState?: "restored" | "unrestored" } = {},
): ColonyView {
  const reserveState = overrides.reserveState ?? "restored";
  const rclPolicy = projectColonyRclPolicy({
    activeThreat: overrides.activeThreat ?? false,
    controllerLevel: 3,
    controllerRisk: overrides.controllerRisk ?? false,
    cpuMode: "normal",
    energyAvailable: reserveState === "restored" ? 800 : 0,
    energyCapacityAvailable: 800,
    protectedSpawnEnergy: 300,
    rcl8Health: null,
    state: overrides.state ?? "developing",
    visibility: overrides.visibility ?? "visible",
  });
  const { reserveState: _reserveState, ...colonyOverrides } = overrides;
  void _reserveState;
  return {
    activeThreat: false,
    controllerRisk: false,
    id: "W1N1",
    legalWorkforce: true,
    rclPolicy,
    roomName: "W1N1",
    state: "developing",
    visibility: "visible",
    ...colonyOverrides,
  } as ColonyView;
}
function planMigration(
  overrides: Partial<Parameters<ConstructionPlanner["planMigration"]>[0]> = {},
) {
  return new ConstructionPlanner().planMigration({
    colony: migrationColony(),
    commitment: migrationCommitment,
    globalOwnedSiteCount: 0,
    observationFingerprint: "observation-a",
    placements: migrationPlacements(),
    policyFingerprint: "policy-a",
    room: migrationRoom(),
    ...overrides,
  });
}
