import { describe, expect, it } from "vitest";
import { COLONY_RCL_POLICY_TABLE } from "../src/colony/rcl-policy";
import {
  isStaleLayoutContainerMigrationContinuation,
  isStaleLayoutExtensionEvacuationContinuation,
  isStaleLayoutLinkEvacuationContinuation,
  isStaleLayoutSpawnEvacuationContinuation,
  isStaleLayoutTowerEvacuationContinuation,
  planOwnedRoomLayout,
  planOwnedRoomLayouts,
  projectLayoutConvergencePlacements,
  reconstructStaleLayoutLinkPlacements,
  selectLayoutPlanningWindow,
  type LayoutPlanningInput,
  type StaleLayoutRecord,
} from "../src/layout";

describe("stale container migration continuation", () => {
  const staleRecord = (): StaleLayoutRecord => ({
    algorithmRevision: "owned-room-layout-v1",
    anchor: { roomName: "W1N1", x: 25, y: 25 },
    blockers: [],
    committedAt: 1,
    containerMigration: {
      energyAmount: 500,
      expiresAt: 250,
      replacementId: "container-replacement",
      replacementInitialEnergy: 100,
      startedAt: 100,
      targetId: "container-obsolete",
    },
    fingerprint: "stale-layout",
    roomName: "W1N1",
    sourceServices: [],
    transform: 0,
  });

  it("admits bounded source-specific resource manifests", () => {
    const migration = staleRecord().containerMigration;
    if (migration === undefined) throw new Error("stale container migration fixture missing");
    expect(isStaleLayoutContainerMigrationContinuation(staleRecord())).toBe(true);
    const {
      energyAmount: _energy,
      replacementInitialEnergy: _energyBaseline,
      ...manifestBase
    } = migration;
    void [_energy, _energyBaseline];
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: { ...manifestBase, resourceManifest: [["U", 500, 100]] },
      }),
    ).toBe(true);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        algorithmRevision: "owned-room-layout-v2-source-services",
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [["energy", 500, 100]],
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [
            ["H", 250, 50],
            ["U", 250, 50],
          ],
        },
      }),
    ).toBe(true);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [
            ["H", 1, 0],
            ["O", 1, 0],
            ["U", 1, 0],
            ["X", 1, 0],
            ["Z", 1, 0],
            ["energy", 1, 0],
            ["power", 1, 0],
            ["silicon", 1, 0],
          ],
        },
      }),
    ).toBe(true);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [
            ["H", 1, 0],
            ["O", 1, 0],
            ["U", 1, 0],
            ["X", 1, 0],
            ["Z", 1, 0],
            ["energy", 1, 0],
            ["mist", 1, 0],
            ["power", 1, 0],
            ["silicon", 1, 0],
          ],
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [
            ["U", 1, 0],
            ["U", 1, 0],
          ],
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [
            ["U", 1, 0],
            ["energy", 2_000, 0],
          ],
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: { ...migration, expiresAt: 251 },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: { ...migration, sourceId: "source-a" },
      }),
    ).toBe(true);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [["U", 500, 100]],
          sourceId: "source-a",
        },
      }),
    ).toBe(true);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: {
          ...manifestBase,
          resourceManifest: [
            ["H", 250, 50],
            ["U", 250, 50],
          ],
          sourceId: "source-a",
        },
      }),
    ).toBe(true);
    const { replacementInitialEnergy: _baseline, ...withoutBaseline } = migration;
    void _baseline;
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        containerMigration: withoutBaseline,
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        extensionEvacuation: {
          amount: 50,
          expiresAt: 250,
          replacementId: "extension-replacement",
          replacementInitialEnergy: 0,
          sourceId: "extension-obsolete",
          startedAt: 100,
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutContainerMigrationContinuation({
        ...staleRecord(),
        removalReceipt: {
          attempt: 1,
          code: "OK",
          nextEligibleTick: 101,
          observedAt: 100,
          replacementId: "container-replacement",
          targetId: "container-obsolete",
          targetStructureType: "container",
        },
      }),
    ).toBe(false);
  });
});

describe("stale extension evacuation continuation", () => {
  const staleRecord = (): StaleLayoutRecord => ({
    algorithmRevision: "owned-room-layout-v1",
    anchor: { roomName: "W1N1", x: 25, y: 25 },
    blockers: [],
    committedAt: 1,
    extensionEvacuation: {
      amount: 50,
      expiresAt: 250,
      replacementId: "extension-replacement",
      replacementInitialEnergy: 0,
      sourceId: "extension-obsolete",
      startedAt: 100,
    },
    fingerprint: "stale-layout",
    roomName: "W1N1",
    sourceServices: [
      {
        adoption: "exact",
        layer: "primary",
        minimumRcl: 2,
        pos: { roomName: "W1N1", x: 11, y: 11 },
        service: { kind: "source-container", sourceId: "source-a" },
        structureType: "container",
      },
    ],
    transform: 0,
  });

  it("admits only the sole otherwise-quiescent stale extension term", () => {
    const sourceService = staleRecord().sourceServices?.[0];
    if (sourceService === undefined) throw new Error("stale source service fixture missing");
    expect(isStaleLayoutExtensionEvacuationContinuation(staleRecord())).toBe(true);
    expect(
      isStaleLayoutExtensionEvacuationContinuation({
        ...staleRecord(),
        algorithmRevision: "owned-room-layout-v2-source-services",
      }),
    ).toBe(false);
    expect(
      isStaleLayoutExtensionEvacuationContinuation({
        ...staleRecord(),
        siteReceipts: [
          {
            attempt: 1,
            code: "OK",
            layoutFingerprint: "stale-layout",
            nextEligibleTick: 101,
            observationFingerprint: "observation-a",
            observedAt: 100,
            policyFingerprint: "policy-a",
            proposalId: "site-a",
            roomName: "W1N1",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isStaleLayoutExtensionEvacuationContinuation({
        ...staleRecord(),
        towerEvacuation: {
          amount: 10,
          expiresAt: 250,
          replacementId: "tower-replacement",
          replacementInitialEnergy: 10,
          sourceId: "tower-obsolete",
          startedAt: 100,
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutExtensionEvacuationContinuation({
        ...staleRecord(),
        sourceServices: [
          {
            ...sourceService,
            service: { issuerSequence: 2, kind: "source-container", sourceId: "source-a" },
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("stale tower evacuation continuation", () => {
  const staleRecord = (): StaleLayoutRecord => ({
    algorithmRevision: "owned-room-layout-v1",
    anchor: { roomName: "W1N1", x: 25, y: 25 },
    blockers: [],
    committedAt: 1,
    fingerprint: "stale-layout",
    roomName: "W1N1",
    sourceServices: [],
    towerEvacuation: {
      amount: 500,
      expiresAt: 250,
      replacementId: "tower-replacement",
      replacementInitialEnergy: 10,
      sourceId: "tower-obsolete",
      startedAt: 100,
    },
    transform: 0,
  });

  it("admits only the sole otherwise-quiescent stale tower term", () => {
    expect(isStaleLayoutTowerEvacuationContinuation(staleRecord())).toBe(true);
    expect(
      isStaleLayoutTowerEvacuationContinuation({
        ...staleRecord(),
        algorithmRevision: "owned-room-layout-v2-source-services",
      }),
    ).toBe(false);
    expect(
      isStaleLayoutTowerEvacuationContinuation({
        ...staleRecord(),
        extensionEvacuation: {
          amount: 50,
          expiresAt: 250,
          replacementId: "extension-replacement",
          replacementInitialEnergy: 0,
          sourceId: "extension-obsolete",
          startedAt: 100,
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutTowerEvacuationContinuation({
        ...staleRecord(),
        removalReceipt: {
          attempt: 1,
          code: "OK",
          nextEligibleTick: 101,
          observedAt: 100,
          replacementId: "tower-replacement",
          targetId: "tower-obsolete",
          targetStructureType: "tower",
        },
      }),
    ).toBe(false);
  });
});

describe("stale reserve-link evacuation continuation", () => {
  const staleRecord = (): StaleLayoutRecord => ({
    algorithmRevision: "owned-room-layout-v1",
    anchor: { roomName: "W1N1", x: 25, y: 25 },
    blockers: [],
    committedAt: 1,
    fingerprint: "stale-layout",
    linkEvacuation: {
      amount: 800,
      expiresAt: 250,
      replacementId: "link-replacement",
      replacementInitialEnergy: 0,
      sourceId: "link-obsolete",
      startedAt: 100,
    },
    roomName: "W1N1",
    sourceServices: [
      {
        adoption: "exact",
        layer: "primary",
        minimumRcl: 2,
        pos: { roomName: "W1N1", x: 11, y: 11 },
        service: { kind: "source-container", sourceId: "source-a" },
        structureType: "container",
      },
    ],
    transform: 0,
  });

  it("reconstructs only known V1 link positions as narrow role-safety evidence", () => {
    const unlocks = COLONY_RCL_POLICY_TABLE.find(({ level }) => level === 8)?.unlocks;
    if (unlocks === undefined) throw new Error("RCL8 policy missing");
    expect(
      reconstructStaleLayoutLinkPlacements({
        commitment: staleRecord(),
        roomName: "W1N1",
        unlocks,
      }),
    ).toHaveLength(6);
    expect(
      reconstructStaleLayoutLinkPlacements({
        commitment: { ...staleRecord(), algorithmRevision: "unknown-layout-revision" },
        roomName: "W1N1",
        unlocks,
      }),
    ).toBeNull();
    expect(
      reconstructStaleLayoutLinkPlacements({
        commitment: {
          ...staleRecord(),
          algorithmRevision: "owned-room-layout-v2-source-services",
        },
        roomName: "W1N1",
        unlocks,
      }),
    ).toBeNull();
  });

  it("admits only the sole otherwise-quiescent known stale reserve-link term", () => {
    const sourceService = staleRecord().sourceServices?.[0];
    if (sourceService === undefined) throw new Error("stale source service fixture missing");
    expect(isStaleLayoutLinkEvacuationContinuation(staleRecord())).toBe(true);
    expect(
      isStaleLayoutLinkEvacuationContinuation({
        ...staleRecord(),
        algorithmRevision: "unknown-layout-revision",
      }),
    ).toBe(false);
    expect(
      isStaleLayoutLinkEvacuationContinuation({
        ...staleRecord(),
        algorithmRevision: "owned-room-layout-v2-source-services",
      }),
    ).toBe(false);
    expect(
      isStaleLayoutLinkEvacuationContinuation({
        ...staleRecord(),
        spawnEvacuation: {
          amount: 300,
          expiresAt: 250,
          replacementId: "spawn-replacement",
          replacementInitialEnergy: 0,
          sourceId: "spawn-obsolete",
          startedAt: 100,
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutLinkEvacuationContinuation({
        ...staleRecord(),
        sourceServices: [
          {
            ...sourceService,
            service: { issuerSequence: 2, kind: "source-container", sourceId: "source-a" },
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("stale spawn evacuation continuation", () => {
  const staleRecord = (): StaleLayoutRecord => ({
    algorithmRevision: "owned-room-layout-v1",
    anchor: { roomName: "W1N1", x: 25, y: 25 },
    blockers: [],
    committedAt: 1,
    fingerprint: "stale-layout",
    roomName: "W1N1",
    sourceServices: [],
    spawnEvacuation: {
      amount: 300,
      expiresAt: 250,
      replacementId: "spawn-replacement",
      replacementInitialEnergy: 0,
      sourceId: "spawn-obsolete",
      startedAt: 100,
    },
    transform: 0,
  });

  it("admits only the sole otherwise-quiescent stale spawn term", () => {
    expect(isStaleLayoutSpawnEvacuationContinuation(staleRecord())).toBe(true);
    expect(
      isStaleLayoutSpawnEvacuationContinuation({
        ...staleRecord(),
        algorithmRevision: "owned-room-layout-v2-source-services",
      }),
    ).toBe(false);
    expect(
      isStaleLayoutSpawnEvacuationContinuation({
        ...staleRecord(),
        towerEvacuation: {
          amount: 10,
          expiresAt: 250,
          replacementId: "tower-replacement",
          replacementInitialEnergy: 10,
          sourceId: "tower-obsolete",
          startedAt: 100,
        },
      }),
    ).toBe(false);
    expect(
      isStaleLayoutSpawnEvacuationContinuation({
        ...staleRecord(),
        removalReceipt: {
          attempt: 1,
          code: "OK",
          nextEligibleTick: 101,
          observedAt: 100,
          replacementId: "spawn-replacement",
          targetId: "spawn-obsolete",
          targetStructureType: "spawn",
        },
      }),
    ).toBe(false);
  });
});

describe("owned-room-layout-v1", () => {
  it("produces byte-equivalent complete placements across reordered facts and heap reconstruction", () => {
    const input = fixture(8);
    const first = planOwnedRoomLayout(input);
    const reordered = planOwnedRoomLayout({
      ...fixture(8),
      sources: [...input.sources].reverse(),
      structures: [...input.structures].reverse(),
      exits: [...input.exits].reverse(),
    });
    expect(first.status).toBe("complete");
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
    if (first.status === "complete") {
      expect(
        first.placements.some((p) => p.adoption === "exact" && p.structureType === "spawn"),
      ).toBe(true);
      expect(
        first.placements
          .filter(({ service }) => service?.kind === "source-container")
          .map(({ service }) => service?.sourceId),
      ).toEqual(["source-a", "source-b"]);
    }
  });

  it.each(COLONY_RCL_POLICY_TABLE)("does not exceed ColonyView RCL $level allowances", (row) => {
    const result = planOwnedRoomLayout(fixture(row.level));
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    const count = (type: string) =>
      result.placements.filter((p) => p.layer === "primary" && p.structureType === type).length;
    expect(count("spawn")).toBeLessThanOrEqual(row.unlocks.spawns);
    expect(count("extension")).toBeLessThanOrEqual(row.unlocks.extensions);
    expect(count("tower")).toBeLessThanOrEqual(row.unlocks.towers);
    expect(count("lab")).toBeLessThanOrEqual(row.unlocks.labs);
  });

  it("preserves the prior commitment and emits no partial/action output for blocked terrain", () => {
    const prior = completeCommitment();
    const input = fixture(4);
    const result = planOwnedRoomLayout({
      ...input,
      priorCommitment: prior,
      terrain: { cells: "1".repeat(2500), revision: "blocked" },
    });
    expect(result).toMatchObject({ status: "degraded", commitment: prior, placements: [] });
    expect(JSON.stringify(result)).not.toMatch(/createConstructionSite|dismantle|remove/u);
  });

  it("never commits planned geometry on an observed source tile", () => {
    const input = fixture(4);
    const sources = [
      { roomName: input.roomName, sourceId: "source-a", x: 25, y: 25 },
      { roomName: input.roomName, sourceId: "source-b", x: 40, y: 8 },
    ];
    const result = planOwnedRoomLayout({ ...input, sources, structures: [] });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.candidatesInspected).toBeGreaterThan(1);
    expect(
      result.placements.some(({ pos: placement }) =>
        sources.some((source) => source.x === placement.x && source.y === placement.y),
      ),
    ).toBe(false);
  });

  it("rejects candidate geometry that strands an owned source", () => {
    const prior = completeCommitment();
    const input = fixture(4);
    const cells = input.terrain.cells.split("");
    for (let y = 9; y <= 11; y += 1)
      for (let x = 9; x <= 11; x += 1)
        if ((x !== 10 || y !== 10) && (x !== 11 || y !== 11)) cells[y * 50 + x] = "1";
    const trapped = {
      ...input,
      priorCommitment: prior,
      sources: [
        { roomName: input.roomName, sourceId: "source-a", x: 10, y: 10 },
        { roomName: input.roomName, sourceId: "source-b", x: 40, y: 8 },
      ],
      structures: [...input.structures, structure("tower", 11, 11, "owned")],
      terrain: { cells: cells.join(""), revision: "source-access-blocked" },
    };

    const result = planOwnedRoomLayout(trapped);
    expect(result).toMatchObject({
      blocker: "access-blocked",
      commitment: prior,
      placements: [],
      status: "degraded",
    });
    expect(result.floodCellsInspected).toBeLessThanOrEqual(result.candidatesInspected * 8 * 2_500);

    const reconstructed = JSON.parse(JSON.stringify(trapped)) as LayoutPlanningInput;
    const reordered = {
      ...reconstructed,
      exits: [...reconstructed.exits].reverse(),
      sources: [...reconstructed.sources].reverse(),
      structures: [...reconstructed.structures].reverse(),
    };
    expect(JSON.stringify(planOwnedRoomLayout(reordered))).toBe(JSON.stringify(result));
  });

  it("does not treat a private foreign rampart as executable source access", () => {
    const prior = completeCommitment();
    const input = fixture(4);
    const cells = input.terrain.cells.split("");
    for (let y = 9; y <= 11; y += 1)
      for (let x = 9; x <= 11; x += 1)
        if ((x !== 10 || y !== 10) && (x !== 11 || y !== 11)) cells[y * 50 + x] = "1";
    const privateRampart = {
      ...structure("rampart", 11, 11, "foreign"),
      isPublic: false,
    };
    const blocked = {
      ...input,
      priorCommitment: prior,
      sources: [
        { roomName: input.roomName, sourceId: "source-a", x: 10, y: 10 },
        { roomName: input.roomName, sourceId: "source-b", x: 40, y: 8 },
      ],
      structures: [...input.structures, privateRampart],
      terrain: { cells: cells.join(""), revision: "private-rampart-source-access" },
    };

    expect(planOwnedRoomLayout(blocked)).toMatchObject({
      blocker: "access-blocked",
      commitment: prior,
      placements: [],
      status: "degraded",
    });
    expect(
      planOwnedRoomLayout({
        ...blocked,
        structures: [
          ...input.structures,
          { ...privateRampart, ownerUsername: "Myrmex", ownership: "owned" as const },
        ],
      }).status,
    ).toBe("complete");
    expect(
      planOwnedRoomLayout({
        ...blocked,
        structures: [...input.structures, { ...privateRampart, isPublic: true }],
      }).status,
    ).toBe("complete");
  });

  it("treats a future nonwalkable construction site as blocked source access", () => {
    const prior = completeCommitment();
    const input = fixture(4);
    const cells = input.terrain.cells.split("");
    for (let y = 9; y <= 11; y += 1)
      for (let x = 9; x <= 11; x += 1)
        if ((x !== 10 || y !== 10) && (x !== 11 || y !== 11)) cells[y * 50 + x] = "1";
    const result = planOwnedRoomLayout({
      ...input,
      constructionSites: [
        {
          id: "blocking-extension-site",
          ownerUsername: "Myrmex",
          ownership: "owned",
          pos: { roomName: input.roomName, x: 11, y: 11 },
          progress: 0,
          progressTotal: 3_000,
          structureType: "extension",
        },
      ],
      priorCommitment: prior,
      sources: [
        { roomName: input.roomName, sourceId: "source-a", x: 10, y: 10 },
        { roomName: input.roomName, sourceId: "source-b", x: 40, y: 8 },
      ],
      terrain: { cells: cells.join(""), revision: "construction-site-source-access" },
    });

    expect(result).toMatchObject({
      blocker: "access-blocked",
      commitment: prior,
      placements: [],
      status: "degraded",
    });
  });

  it("rejects a source chamber disconnected from otherwise accessible colony geometry", () => {
    const prior = completeCommitment();
    const input = fixture(4);
    const cells = "1".repeat(2_500).split("");
    for (let y = 0; y <= 17; y += 1) for (let x = 1; x <= 17; x += 1) cells[y * 50 + x] = "0";
    for (let y = 39; y <= 41; y += 1) for (let x = 39; x <= 41; x += 1) cells[y * 50 + x] = "0";
    const disconnected = {
      ...input,
      controller: { roomName: input.roomName, x: 15, y: 15 },
      exits: Array.from({ length: 17 }, (_, offset) => ({
        roomName: input.roomName,
        x: offset + 1,
        y: 0,
      })),
      mineral: null,
      priorCommitment: prior,
      sources: [
        { roomName: input.roomName, sourceId: "source-a", x: 40, y: 40 },
        { roomName: input.roomName, sourceId: "source-b", x: 3, y: 3 },
      ],
      structures: [structure("spawn", 9, 9, "owned")],
      terrain: { cells: cells.join(""), revision: "source-chamber-disconnected" },
    };

    const result = planOwnedRoomLayout(disconnected);
    expect(result).toMatchObject({ commitment: prior, placements: [], status: "degraded" });
    expect(result.floodCellsInspected).toBeGreaterThan(0);
    expect(result.floodCellsInspected).toBeLessThanOrEqual(result.candidatesInspected * 8 * 2_500);
  });

  it("skips planned geometry that disconnects a source and commits a reachable transform", () => {
    const input = fixture(4);
    const cells = input.terrain.cells.split("");
    for (let coordinate = 16; coordinate <= 22; coordinate += 1) {
      cells[16 * 50 + coordinate] = "1";
      cells[22 * 50 + coordinate] = "1";
      cells[coordinate * 50 + 16] = "1";
      cells[coordinate * 50 + 22] = "1";
    }
    cells[22 * 50 + 22] = "0";
    const result = planOwnedRoomLayout({
      ...input,
      sources: [
        { roomName: input.roomName, sourceId: "source-a", x: 19, y: 19 },
        { roomName: input.roomName, sourceId: "source-b", x: 40, y: 8 },
      ],
      terrain: { cells: cells.join(""), revision: "planned-source-gate" },
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.transformsInspected).toBeGreaterThan(1);
    expect(
      result.placements
        .filter(({ service }) => service?.kind === "source-container")
        .map(({ service }) => service?.sourceId),
    ).toEqual(["source-a", "source-b"]);
  });

  it("does not publish a complete commitment when source-service assignment is incomplete", () => {
    const prior = completeCommitment();
    const input = fixture(4);
    const cells = "1".repeat(2_500).split("");
    for (let y = 0; y <= 17; y += 1) for (let x = 1; x <= 17; x += 1) cells[y * 50 + x] = "0";
    const sourceA = { roomName: input.roomName, sourceId: "source-a", x: 14, y: 14 };
    const sourceB = { roomName: input.roomName, sourceId: "source-b", x: 16, y: 14 };
    for (const source of [sourceA, sourceB])
      for (let y = source.y - 1; y <= source.y + 1; y += 1)
        for (let x = source.x - 1; x <= source.x + 1; x += 1)
          if (
            (x !== sourceA.x || y !== sourceA.y) &&
            (x !== sourceB.x || y !== sourceB.y) &&
            (x !== 15 || y !== 14) &&
            (x !== 14 || y !== 15)
          )
            cells[y * 50 + x] = "1";
    const competing = {
      ...input,
      controller: { roomName: input.roomName, x: 3, y: 3 },
      exits: Array.from({ length: 17 }, (_, offset) => ({
        roomName: input.roomName,
        x: offset + 1,
        y: 0,
      })),
      mineral: null,
      priorCommitment: prior,
      sources: [sourceA, sourceB],
      structures: [structure("spawn", 9, 9, "owned"), structure("container", 15, 14, "unowned")],
      terrain: { cells: cells.join(""), revision: "source-service-assignment-conflict" },
    };

    const result = planOwnedRoomLayout(competing);
    expect(result).toMatchObject({ commitment: prior, placements: [], status: "degraded" });
    expect(result.floodCellsInspected).toBeGreaterThan(0);
  });

  it("rejects a commitment whose adopted spawn cannot reach its source services", () => {
    const prior = completeCommitment();
    const input = fixture(4);
    const cells = "1".repeat(2_500).split("");
    cells[8 * 50 + 8] = "0";
    for (let y = 32; y <= 49; y += 1) for (let x = 32; x <= 48; x += 1) cells[y * 50 + x] = "0";
    const result = planOwnedRoomLayout({
      ...input,
      controller: { roomName: input.roomName, x: 45, y: 45 },
      exits: Array.from({ length: 17 }, (_, offset) => ({
        roomName: input.roomName,
        x: offset + 32,
        y: 49,
      })),
      mineral: null,
      priorCommitment: prior,
      sources: [
        { roomName: input.roomName, sourceId: "source-a", x: 34, y: 45 },
        { roomName: input.roomName, sourceId: "source-b", x: 45, y: 34 },
      ],
      structures: [structure("spawn", 8, 8, "owned")],
      terrain: { cells: cells.join(""), revision: "adopted-spawn-trapped" },
    });

    expect(result).toMatchObject({ commitment: prior, placements: [], status: "degraded" });
    expect(result.floodCellsInspected).toBeGreaterThan(0);
    expect(result.floodCellsInspected).toBeLessThanOrEqual(
      result.candidatesInspected * 8 * 2 * 2_500,
    );
  });

  it("bounds edge-spawn/conflict search and room scheduling", () => {
    const edge = { ...fixture(4), structures: [structure("spawn", 2, 2, "owned")] };
    const result = planOwnedRoomLayout(edge);
    expect(result.candidatesInspected).toBeLessThanOrEqual(256);
    expect(result.transformsInspected).toBeLessThanOrEqual(2048);
    expect(result.floodCellsInspected).toBeLessThanOrEqual(256 * 8 * 2500);
    const rooms = [fixture(4, "W3N3"), fixture(4, "W1N1"), fixture(4, "W2N2")];
    expect(planOwnedRoomLayouts(rooms)).toHaveLength(2);
    expect(
      new Set(
        [100, 101].flatMap((tick) =>
          selectLayoutPlanningWindow(rooms, tick).map(({ roomName }) => roomName),
        ),
      ),
    ).toEqual(new Set(["W1N1", "W2N2", "W3N3"]));
  });

  it("adopts compatible external structures without suggesting removal", () => {
    const input = fixture(4);
    const manual = structure("tower", 35, 35, "owned");
    const result = planOwnedRoomLayout({ ...input, structures: [...input.structures, manual] });
    expect(result.status).toBe("complete");
    if (result.status === "complete")
      expect(result.placements).toContainEqual(
        expect.objectContaining({
          structureType: "tower",
          adoption: "compatible-external",
          pos: manual.pos,
        }),
      );
  });

  it("restores committed storage geometry only when terminal allowance is unlocked", () => {
    const input = fixture(6);
    const external = structure("storage", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    if (planned.status !== "complete") throw new Error("expected complete layout");
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "storage",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "storage")).toHaveLength(1);
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "storage" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);

    const rcl4 = fixture(4);
    const rcl4Planned = planOwnedRoomLayout({
      ...rcl4,
      structures: [...rcl4.structures, external],
    });
    if (rcl4Planned.status !== "complete") throw new Error("expected complete RCL4 layout");
    if (rcl4.policy.unlocks === null) throw new Error("expected RCL4 unlocks");
    expect(
      projectLayoutConvergencePlacements({
        commitment: rcl4Planned.commitment,
        current: rcl4Planned.placements,
        roomName: rcl4.roomName,
        sourceCount: rcl4.sources.length,
        sources: rcl4.sources,
        unlocks: rcl4.policy.unlocks,
      }),
    ).toEqual(rcl4Planned.placements);
  });

  it("restores committed terminal geometry for one bounded service outage", () => {
    const input = fixture(6);
    const external = structure("terminal", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    if (planned.status !== "complete") throw new Error("expected complete layout");
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "terminal",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "terminal")).toHaveLength(1);
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "terminal" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);
  });

  it("restores committed spawn geometry only when redundant spawn service is available", () => {
    const input = fixture(8);
    const external = structure("spawn", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    if (planned.status !== "complete") throw new Error("expected complete layout");
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "spawn",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "spawn")).toHaveLength(3);
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "spawn" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);

    const rcl6 = fixture(6);
    const rcl6Planned = planOwnedRoomLayout({
      ...rcl6,
      structures: [...rcl6.structures, external],
    });
    if (rcl6Planned.status !== "complete") throw new Error("expected complete RCL6 layout");
    if (rcl6.policy.unlocks === null) throw new Error("expected RCL6 unlocks");
    expect(
      projectLayoutConvergencePlacements({
        commitment: rcl6Planned.commitment,
        current: rcl6Planned.placements,
        roomName: rcl6.roomName,
        sourceCount: rcl6.sources.length,
        sources: rcl6.sources,
        unlocks: rcl6.policy.unlocks,
      }),
    ).toEqual(rcl6Planned.placements);
  });

  it("restores committed tower geometry for replacement-first defensive convergence", () => {
    const input = fixture(5);
    const external = structure("tower", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    if (planned.status !== "complete") throw new Error("expected complete layout");
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "tower",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "tower")).toHaveLength(2);
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "tower" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);
  });

  it("restores committed link geometry through ordinary replacement-first convergence", () => {
    const input = fixture(8);
    const external = structure("link", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    if (planned.status !== "complete") throw new Error("expected complete layout");
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "link",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "link")).toHaveLength(6);
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "link" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);
  });

  it("restores committed lab geometry while external labs remain usable", () => {
    const input = fixture(8);
    const external = structure("lab", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    if (planned.status !== "complete") throw new Error("expected complete layout");
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "lab",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "lab")).toHaveLength(10);
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "lab" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);
  });

  it("uses committed extension geometry only for replacement-first convergence", () => {
    const input = fixture(3);
    const external = structure("extension", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    expect(planned.status).toBe("complete");
    if (planned.status !== "complete") return;
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "extension",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "extension")).toHaveLength(
      10,
    );
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "extension" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);
    expect(
      convergent.filter(
        ({ structureType }) => structureType !== "extension" && structureType !== "container",
      ),
    ).toEqual(
      planned.placements.filter(
        ({ structureType }) => structureType !== "extension" && structureType !== "container",
      ),
    );
  });

  it("restores committed general-container geometry while preserving source services", () => {
    const input = fixture(3);
    const external = structure("container", 35, 35, "owned");
    const planned = planOwnedRoomLayout({ ...input, structures: [...input.structures, external] });
    if (planned.status !== "complete") throw new Error("expected complete layout");
    const unlocks = input.policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const services = planned.placements.filter(
      ({ service }) => service?.kind === "source-container",
    );
    const convergent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: input.sources,
      unlocks,
    });

    expect(planned.placements).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "container",
      }),
    );
    expect(convergent.filter(({ structureType }) => structureType === "container")).toHaveLength(5);
    expect(
      convergent.some(
        ({ pos, structureType }) =>
          structureType === "container" && pos.x === external.pos.x && pos.y === external.pos.y,
      ),
    ).toBe(false);
    expect(convergent.filter(({ service }) => service?.kind === "source-container")).toEqual(
      services,
    );
    const canonicalGeneral = convergent.find(
      ({ service, structureType }) => structureType === "container" && service === undefined,
    );
    if (canonicalGeneral === undefined) throw new Error("expected canonical general container");
    const secondSource = input.sources[1];
    if (secondSource === undefined) throw new Error("expected second source");
    const sourceAdjacent = projectLayoutConvergencePlacements({
      commitment: planned.commitment,
      current: planned.placements,
      roomName: input.roomName,
      sourceCount: input.sources.length,
      sources: [
        { ...canonicalGeneral.pos, sourceId: "source-a", x: canonicalGeneral.pos.x - 1 },
        secondSource,
      ],
      unlocks,
    });
    expect(sourceAdjacent).toContainEqual(
      expect.objectContaining({
        adoption: "compatible-external",
        pos: external.pos,
        structureType: "container",
      }),
    );
    expect(
      sourceAdjacent.some(
        ({ adoption, service, structureType }) =>
          structureType === "container" && service === undefined && adoption === "planned",
      ),
    ).toBe(false);
  });
});

function fixture(level: number, roomName = "W1N1"): LayoutPlanningInput {
  const row = COLONY_RCL_POLICY_TABLE.find((r) => r.level === level);
  if (!row) throw new Error("row");
  const cells = Array.from({ length: 2500 }, (_, i) =>
    i % 50 === 0 || i % 50 === 49 || i < 50 || i >= 2450 ? "0" : i % 113 === 0 ? "2" : "0",
  ).join("");
  return {
    roomName,
    tick: 100,
    terrain: { cells, revision: "terrain-a" },
    exits: Array.from({ length: 48 }, (_, x) => ({ roomName, x: x + 1, y: 0 })),
    controller: { roomName, x: 40, y: 40 },
    sources: [
      { roomName, sourceId: "source-b", x: 8, y: 8 },
      { roomName, sourceId: "source-a", x: 40, y: 8 },
    ],
    mineral: { id: "m", mineralType: "H", pos: { roomName, x: 8, y: 40 } },
    structures: [structure("spawn", 25, 25, "owned", roomName)],
    constructionSites: [],
    priorCommitment: null,
    policy: {
      version: 1,
      level,
      spawnPoolCapacityTarget: row.spawnPoolCapacityTarget,
      unlocks: row.unlocks,
      protectedSpawnReserve: { target: 300, available: 800, state: "restored" },
      domains: [],
      progression: { status: "authorized", authorized: true, reasonCode: "active" },
    },
  };
}
function structure(
  structureType: string,
  x: number,
  y: number,
  ownership: "owned" | "foreign" | "unowned",
  roomName = "W1N1",
) {
  return {
    hits: 5000,
    hitsMax: 5000,
    id: `${structureType}-${String(x)}-${String(y)}`,
    ownerUsername: ownership === "owned" ? "Myrmex" : ownership === "foreign" ? "Enemy" : null,
    ownership,
    pos: { roomName, x, y },
    structureType,
  } as const;
}
function completeCommitment() {
  return {
    algorithmRevision: "owned-room-layout-v2-source-services",
    anchor: { roomName: "W1N1", x: 25, y: 25 },
    blockers: [],
    committedAt: 90,
    fingerprint: "layout-v2:prior",
    transform: 0,
  } as const;
}
