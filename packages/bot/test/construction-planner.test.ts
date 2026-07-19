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

  it("stages one general-container replacement and waits for active logistics to retire", () => {
    const fixture = generalContainerMigrationFixture();
    const missingEvidence = planMigration({
      currentPlacements: fixture.currentPlacements,
      placements: fixture.placements,
      room: fixture.room,
    });
    expect(missingEvidence.containerMigration).toBeNull();
    expect(missingEvidence.blockers).toContainEqual(
      expect.objectContaining({ reason: "logistics-unavailable" }),
    );
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: {
          ...fixture.room,
          sources: fixture.room.sources.map((source, index) =>
            index === 0 ? { ...source, pos: { roomName: "W1N1", x: 19, y: 19 } } : source,
          ),
        },
      }).containerMigration,
    ).toBeNull();

    const staged = planMigration({
      activeLogisticsTargetIds: new Set(),
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: fixture.room,
    });
    expect(staged.proposals).toEqual([]);
    expect(staged.containerMigration).toEqual({
      expiresAt: 250,
      replacementId: "container-general-b",
      startedAt: 100,
      targetId: "container-obsolete",
    });
    if (staged.containerMigration === null) throw new Error("expected staged container migration");
    const sameTick = planMigration({
      activeLogisticsTargetIds: new Set(),
      containerMigration: staged.containerMigration,
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: fixture.room,
    });
    expect(sameTick.proposals).toEqual([]);
    expect(sameTick.blockers).toContainEqual(
      expect.objectContaining({ reason: "migration-pending", targetId: "container-obsolete" }),
    );
    const nextRoom = { ...fixture.room, observedAt: 101 };
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        containerMigration: {
          ...staged.containerMigration,
          expiresAt: 252,
          startedAt: 102,
        },
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: nextRoom,
      }).proposals,
    ).toEqual([]);
    const active = planMigration({
      activeLogisticsTargetIds: new Set(["container-obsolete"]),
      containerMigration: staged.containerMigration,
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: nextRoom,
    });
    expect(active.containerMigration).toEqual(staged.containerMigration);
    expect(active.proposals).toEqual([]);
    expect(active.blockers).toContainEqual(
      expect.objectContaining({ reason: "logistics-active", targetId: "container-obsolete" }),
    );
    const stocked = sourceContainer("container-obsolete", 30, 30, 1);
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: {
          ...nextRoom,
          storedStructures: fixture.room.storedStructures.map((value) =>
            value.id === stocked.id ? stocked : value,
          ),
          structures: (fixture.room.structures ?? []).map((value) =>
            value.id === stocked.id ? stocked : value,
          ),
        },
      }).containerMigration,
    ).toBeNull();
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: { ...fixture.room, observedAt: staged.containerMigration.expiresAt },
      }).containerMigration,
    ).toBeNull();
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: {
          ...nextRoom,
          storedStructures: fixture.room.storedStructures.filter(
            ({ id }) => id !== staged.containerMigration?.replacementId,
          ),
          structures: (fixture.room.structures ?? []).filter(
            ({ id }) => id !== staged.containerMigration?.replacementId,
          ),
        },
      }).containerMigration,
    ).toBeNull();

    const ready = planMigration({
      activeLogisticsTargetIds: new Set(),
      containerMigration: staged.containerMigration,
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: nextRoom,
    });
    const reordered = planMigration({
      activeLogisticsTargetIds: new Set(),
      containerMigration: { ...staged.containerMigration },
      currentPlacements: [...fixture.currentPlacements].reverse(),
      logisticsEvidenceReady: true,
      placements: [...fixture.placements].reverse(),
      room: {
        ...nextRoom,
        storedStructures: [...fixture.room.storedStructures].reverse(),
        structures: [...(fixture.room.structures ?? [])].reverse(),
      },
    });
    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: "container-general-b",
        targetId: "container-obsolete",
        targetStructureType: "container",
      }),
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(ready));
  });

  it("stages exact energy evacuation before removing a stocked general container", () => {
    const fixture = generalContainerMigrationFixture();
    const stockedTarget = sourceContainer("container-obsolete", 30, 30, 50);
    const stockedRoom = {
      ...fixture.room,
      storedStructures: fixture.room.storedStructures.map((value) =>
        value.id === stockedTarget.id ? stockedTarget : value,
      ),
      structures: (fixture.room.structures ?? []).map((value) =>
        value.id === stockedTarget.id ? stockedTarget : value,
      ),
    };
    const staged = planMigration({
      activeLogisticsTargetIds: new Set(),
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: stockedRoom,
    });

    expect(staged.proposals).toEqual([]);
    expect(staged.containerMigration).toMatchObject({
      energyAmount: 50,
      replacementId: "container-general-b",
      replacementInitialEnergy: 0,
      targetId: "container-obsolete",
    });
    const reordered = planMigration({
      activeLogisticsTargetIds: new Set(),
      currentPlacements: [...fixture.currentPlacements].reverse(),
      logisticsEvidenceReady: true,
      placements: [...fixture.placements].reverse(),
      room: {
        ...stockedRoom,
        storedStructures: [...stockedRoom.storedStructures].reverse(),
        structures: [...stockedRoom.structures].reverse(),
      },
    });
    const resetInput = JSON.parse(
      JSON.stringify({
        currentPlacements: fixture.currentPlacements,
        placements: fixture.placements,
        room: stockedRoom,
      }),
    ) as Pick<
      Parameters<ConstructionPlanner["planMigration"]>[0],
      "currentPlacements" | "placements" | "room"
    >;
    const reset = planMigration({
      ...resetInput,
      activeLogisticsTargetIds: new Set(),
      logisticsEvidenceReady: true,
    });
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(staged));
    expect(JSON.stringify(reset)).toBe(JSON.stringify(staged));
    if (staged.containerMigration === null) throw new Error("expected stocked migration");
    const mixedTarget = {
      ...stockedTarget,
      store: {
        ...stockedTarget.store,
        resources: [
          { amount: 25, resourceType: "energy" },
          { amount: 25, resourceType: "U" },
        ],
      },
    };
    const mixedRoom = {
      ...fixture.room,
      storedStructures: fixture.room.storedStructures.map((value) =>
        value.id === mixedTarget.id ? mixedTarget : value,
      ),
      structures: (fixture.room.structures ?? []).map((value) =>
        value.id === mixedTarget.id ? mixedTarget : value,
      ),
    };
    const mixed = planMigration({
      activeLogisticsTargetIds: new Set(),
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: mixedRoom,
    });
    expect(mixed.containerMigration).toMatchObject({
      replacementId: "container-general-b",
      resourceManifest: [
        ["U", 25, 0],
        ["energy", 25, 0],
      ],
      targetId: "container-obsolete",
    });
    const reorderedMixed = planMigration({
      activeLogisticsTargetIds: new Set(),
      currentPlacements: [...fixture.currentPlacements].reverse(),
      logisticsEvidenceReady: true,
      placements: [...fixture.placements].reverse(),
      room: {
        ...mixedRoom,
        storedStructures: [...mixedRoom.storedStructures].reverse().map((value) =>
          value.id === mixedTarget.id
            ? {
                ...value,
                store: { ...value.store, resources: [...value.store.resources].reverse() },
              }
            : value,
        ),
        structures: [...mixedRoom.structures].reverse(),
      },
    });
    const resetMixedInput = JSON.parse(
      JSON.stringify({
        currentPlacements: fixture.currentPlacements,
        placements: fixture.placements,
        room: mixedRoom,
      }),
    ) as Pick<
      Parameters<ConstructionPlanner["planMigration"]>[0],
      "currentPlacements" | "placements" | "room"
    >;
    const resetMixed = planMigration({
      ...resetMixedInput,
      activeLogisticsTargetIds: new Set(),
      logisticsEvidenceReady: true,
    });
    expect(JSON.stringify(reorderedMixed)).toBe(JSON.stringify(mixed));
    expect(JSON.stringify(resetMixed)).toBe(JSON.stringify(mixed));
    if (mixed.containerMigration === null) throw new Error("expected mixed migration");
    const emptiedMixedTarget = sourceContainer("container-obsolete", 30, 30, 0);
    const deliveredMixedReplacement = {
      ...sourceContainer("container-general-b", 21, 20, 0),
      store: {
        capacity: 2_000,
        freeCapacity: 1_950,
        resources: [
          { amount: 25, resourceType: "energy" },
          { amount: 25, resourceType: "U" },
        ],
        usedCapacity: 50,
      },
    };
    const deliveredMixedRoom = {
      ...mixedRoom,
      observedAt: 101,
      storedStructures: mixedRoom.storedStructures.map((value) =>
        value.id === emptiedMixedTarget.id
          ? emptiedMixedTarget
          : value.id === deliveredMixedReplacement.id
            ? deliveredMixedReplacement
            : value,
      ),
      structures: mixedRoom.structures.map((value) =>
        value.id === emptiedMixedTarget.id
          ? emptiedMixedTarget
          : value.id === deliveredMixedReplacement.id
            ? deliveredMixedReplacement
            : value,
      ),
    };
    const incompleteMixedReplacement = {
      ...deliveredMixedReplacement,
      store: {
        ...deliveredMixedReplacement.store,
        freeCapacity: 1_951,
        resources: [
          { amount: 25, resourceType: "energy" },
          { amount: 24, resourceType: "U" },
        ],
        usedCapacity: 49,
      },
    };
    const completeMixed = (room: typeof deliveredMixedRoom, flowIds: ReadonlySet<string>) =>
      planMigration({
        activeLogisticsFlowIds: flowIds,
        activeLogisticsTargetIds: new Set(),
        containerMigration: mixed.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room,
      });
    expect(
      completeMixed(
        {
          ...deliveredMixedRoom,
          storedStructures: deliveredMixedRoom.storedStructures.map((value) =>
            value.id === incompleteMixedReplacement.id ? incompleteMixedReplacement : value,
          ),
          structures: deliveredMixedRoom.structures.map((value) =>
            value.id === incompleteMixedReplacement.id ? incompleteMixedReplacement : value,
          ),
        },
        new Set(),
      ).proposals,
    ).toEqual([]);
    const partialMixedTarget = {
      ...sourceContainer("container-obsolete", 30, 30, 25),
      store: {
        capacity: 2_000,
        freeCapacity: 1_975,
        resources: [{ amount: 25, resourceType: "U" }],
        usedCapacity: 25,
      },
    };
    const partialMixedReplacement = sourceContainer("container-general-b", 21, 20, 25);
    const partialMixed = completeMixed(
      {
        ...deliveredMixedRoom,
        storedStructures: deliveredMixedRoom.storedStructures.map((value) =>
          value.id === partialMixedTarget.id
            ? partialMixedTarget
            : value.id === partialMixedReplacement.id
              ? partialMixedReplacement
              : value,
        ),
        structures: deliveredMixedRoom.structures.map((value) =>
          value.id === partialMixedTarget.id
            ? partialMixedTarget
            : value.id === partialMixedReplacement.id
              ? partialMixedReplacement
              : value,
        ),
      },
      new Set(),
    );
    expect(partialMixed.containerMigration).toEqual(mixed.containerMigration);
    expect(partialMixed.proposals).toEqual([]);
    const capacityLostReplacement = sourceContainer("container-general-b", 21, 20, 1_980);
    const capacityLost = completeMixed(
      {
        ...mixedRoom,
        observedAt: 101,
        storedStructures: mixedRoom.storedStructures.map((value) =>
          value.id === capacityLostReplacement.id ? capacityLostReplacement : value,
        ),
        structures: mixedRoom.structures.map((value) =>
          value.id === capacityLostReplacement.id ? capacityLostReplacement : value,
        ),
      },
      new Set(),
    );
    expect(capacityLost.containerMigration).toEqual(mixed.containerMigration);
    expect(capacityLost.proposals).toEqual([]);
    expect(
      completeMixed(
        deliveredMixedRoom,
        new Set(["layout-container-evacuation:W1N1:container-obsolete:container-general-b:1:U"]),
      ).proposals,
    ).toEqual([]);
    expect(completeMixed(deliveredMixedRoom, new Set()).proposals).toEqual([
      expect.objectContaining({
        replacementId: "container-general-b",
        targetId: "container-obsolete",
      }),
    ]);
    const diverseReplacementResources = [
      { amount: 25, resourceType: "energy" },
      { amount: 25, resourceType: "U" },
      ...Array.from({ length: 7 }, (_, index) => ({
        amount: 1,
        resourceType: `extra-${String(index)}`,
      })),
    ];
    const diverseReplacement = {
      ...deliveredMixedReplacement,
      store: {
        capacity: 2_000,
        freeCapacity: 1_943,
        resources: diverseReplacementResources,
        usedCapacity: 57,
      },
    };
    expect(
      completeMixed(
        {
          ...deliveredMixedRoom,
          storedStructures: deliveredMixedRoom.storedStructures.map((value) =>
            value.id === diverseReplacement.id ? diverseReplacement : value,
          ),
          structures: deliveredMixedRoom.structures.map((value) =>
            value.id === diverseReplacement.id ? diverseReplacement : value,
          ),
        },
        new Set(),
      ).proposals,
    ).toHaveLength(1);

    const fullReplacement = sourceContainer("container-general-b", 21, 20, 1_980);
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: {
          ...stockedRoom,
          storedStructures: stockedRoom.storedStructures.map((value) =>
            value.id === fullReplacement.id ? fullReplacement : value,
          ),
          structures: stockedRoom.structures.map((value) =>
            value.id === fullReplacement.id ? fullReplacement : value,
          ),
        },
      }).containerMigration,
    ).toBeNull();

    const emptiedTarget = sourceContainer("container-obsolete", 30, 30, 0);
    const emptyReplacement = sourceContainer("container-general-b", 21, 20, 0);
    const incompleteRoom = {
      ...stockedRoom,
      observedAt: 101,
      storedStructures: stockedRoom.storedStructures.map((value) =>
        value.id === emptiedTarget.id
          ? emptiedTarget
          : value.id === emptyReplacement.id
            ? emptyReplacement
            : value,
      ),
      structures: stockedRoom.structures.map((value) =>
        value.id === emptiedTarget.id
          ? emptiedTarget
          : value.id === emptyReplacement.id
            ? emptyReplacement
            : value,
      ),
    };
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: incompleteRoom,
      }).blockers,
    ).toContainEqual(expect.objectContaining({ reason: "logistics-unavailable" }));
    const incomplete = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      containerMigration: staged.containerMigration,
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: incompleteRoom,
    });
    expect(incomplete.proposals).toEqual([]);
    expect(incomplete.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-incomplete" }),
    );
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set([
          "layout-container-evacuation:W1N1:container-obsolete:container-general-b",
        ]),
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: incompleteRoom,
      }).proposals,
    ).toEqual([]);

    const deliveredReplacement = sourceContainer("container-general-b", 21, 20, 50);
    const legacyRefilledRoom = {
      ...mixedRoom,
      observedAt: 101,
      storedStructures: mixedRoom.storedStructures.map((value) =>
        value.id === deliveredReplacement.id ? deliveredReplacement : value,
      ),
      structures: mixedRoom.structures.map((value) =>
        value.id === deliveredReplacement.id ? deliveredReplacement : value,
      ),
    };
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: legacyRefilledRoom,
      }).proposals,
    ).toEqual([]);
    const deliveredRoom = {
      ...stockedRoom,
      observedAt: 101,
      storedStructures: stockedRoom.storedStructures.map((value) =>
        value.id === emptiedTarget.id
          ? emptiedTarget
          : value.id === deliveredReplacement.id
            ? deliveredReplacement
            : value,
      ),
      structures: stockedRoom.structures.map((value) =>
        value.id === emptiedTarget.id
          ? emptiedTarget
          : value.id === deliveredReplacement.id
            ? deliveredReplacement
            : value,
      ),
    };
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set([deliveredReplacement.id]),
        containerMigration: staged.containerMigration,
        currentPlacements: fixture.currentPlacements,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: deliveredRoom,
      }).proposals,
    ).toEqual([]);
    const ready = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      containerMigration: staged.containerMigration,
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: deliveredRoom,
    });

    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: "container-general-b",
        targetId: "container-obsolete",
      }),
    ]);
  });

  it("keeps unsafe, mixed-stock, selected, shared, and replacementless containers", () => {
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

function generalContainerMigrationFixture(): {
  readonly currentPlacements: readonly LayoutPlacement[];
  readonly placements: readonly LayoutPlacement[];
  readonly room: RoomSnapshot;
} {
  const sourceA = sourceContainer("container-source-a", 11, 10, 500);
  const sourceB = sourceContainer("container-source-b", 41, 40, 500);
  const generalA = sourceContainer("container-general-a", 20, 20, 0);
  const generalB = sourceContainer("container-general-b", 21, 20, 0);
  const obsolete = sourceContainer("container-obsolete", 30, 30, 0);
  const sourceServices: LayoutPlacement[] = [
    {
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: sourceA.pos,
      service: { kind: "source-container", sourceId: "source-a" },
      structureType: "container",
    },
    {
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: sourceB.pos,
      service: { kind: "source-container", sourceId: "source-b" },
      structureType: "container",
    },
  ];
  const desiredGeneral: LayoutPlacement[] = [
    { ...placement("container", 20, 20), adoption: "exact" },
    { ...placement("container", 21, 20), adoption: "exact" },
    placement("container", 22, 20),
  ];
  return {
    currentPlacements: [
      ...sourceServices,
      ...desiredGeneral.slice(0, 2),
      { ...placement("container", 30, 30), adoption: "compatible-external" },
    ],
    placements: [...sourceServices, ...desiredGeneral],
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
        {
          energy: 3_000,
          energyCapacity: 3_000,
          id: "source-b",
          pos: { roomName: "W1N1", x: 40, y: 40 },
          ticksToRegeneration: null,
        },
      ],
      storedStructures: [sourceA, sourceB, generalA, generalB, obsolete],
      structures: [sourceA, sourceB, generalA, generalB, obsolete],
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
