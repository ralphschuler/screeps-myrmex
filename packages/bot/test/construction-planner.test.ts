import { describe, expect, it, vi } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import { planStaticMining } from "../src/economy";
import { assignLabCluster, fingerprintLabLayout } from "../src/industry";
import {
  STRUCTURE_REMOVAL_LIMITS,
  StructureDestroyExecutor,
  arbitrateStructureRemovals,
  diffOwnedRoomLayout,
  emptyLayoutsOwner,
  layoutLabEvacuationFlowId,
  layoutLinkEvacuationFlowId,
  layoutTowerEvacuationFlowId,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutLabEvacuation,
  reconcileStructureDestroyExecution,
  type LayoutCommitment,
  type LayoutPlacement,
} from "../src/layout";
import {
  arbitrateLinkTransfers,
  classifyLinks,
  deriveLinkRoleAnchors,
  type LinkRoomRuntimeResult,
} from "../src/links";
import { projectLayoutContainerMigrations } from "../src/logistics/container-migration";
import { projectLayoutLabEvacuations } from "../src/logistics/lab-evacuation";
import { ConstructionPlanner, DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY } from "../src/maintenance";
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

  it("never classifies engine-compatible roads as structure-removal candidates", () => {
    const roadOnlyRoom = {
      ...migrationRoom(),
      structures: (migrationRoom().structures ?? []).filter(
        ({ structureType }) => structureType === "road",
      ),
    } as RoomSnapshot;
    const first = planMigration({ room: roadOnlyRoom });
    const reordered = planMigration({
      placements: [...migrationPlacements()].reverse(),
      room: {
        ...roadOnlyRoom,
        structures: [...(roadOnlyRoom.structures ?? [])].reverse(),
      },
    });

    expect(first.authorization).toBeNull();
    expect(first.proposals).toEqual([]);
    expect(first.scannedCandidates).toBe(0);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
  });

  it("admits one canonical empty reserve-link replacement and fails closed on role or activity drift", () => {
    const fixture = reserveLinkMigrationFixture();
    const ready = planMigration({
      activeLogisticsTargetIds: new Set(),
      colony: fixture.colony,
      currentPlacements: fixture.currentPlacements,
      linkRuntime: fixture.linkRuntime,
      logisticsEvidenceReady: true,
      placements: fixture.idealPlacements,
      room: fixture.room,
    });
    const reordered = planMigration({
      activeLogisticsTargetIds: new Set(),
      colony: fixture.colony,
      currentPlacements: [...fixture.currentPlacements].reverse(),
      linkRuntime: JSON.parse(JSON.stringify(fixture.linkRuntime)) as LinkRoomRuntimeResult,
      logisticsEvidenceReady: true,
      placements: [...fixture.idealPlacements].reverse(),
      room: {
        ...fixture.room,
        ownedLinks: [...(fixture.room.ownedLinks ?? [])].reverse(),
        structures: [...(fixture.room.structures ?? [])].reverse(),
      },
    });

    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: "link-reserve-exact",
        replacementStructureType: "link",
        targetId: "link-reserve-external",
        targetRequiresEmptyStore: true,
        targetStructureType: "link",
      }),
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(ready));

    const ownedLinks = fixture.room.ownedLinks;
    const target = ownedLinks?.find(({ id }) => id === "link-reserve-external");
    const replacement = ownedLinks?.find(({ id }) => id === "link-reserve-exact");
    const duplicatePlacement = fixture.currentPlacements.find(
      ({ structureType }) => structureType === "link",
    );
    if (
      target === undefined ||
      replacement === undefined ||
      ownedLinks === undefined ||
      duplicatePlacement === undefined
    )
      throw new Error("expected complete reserve-link fixture");
    const withChangedLink = (id: string, change: Partial<typeof target>) => ({
      ...fixture.room,
      ownedLinks: ownedLinks.map((link) => (link.id === id ? { ...link, ...change } : link)),
    });
    const activeTransfer: LinkRoomRuntimeResult = {
      ...fixture.linkRuntime,
      arbitration: {
        ...fixture.linkRuntime.arbitration,
        accepted: [
          {
            budget: { cost: 1, id: "link-budget" },
            deliveredAmount: 1,
            flowId: "flow-a",
            layoutRevision: fixture.linkRuntime.layoutRevision,
            lostAmount: 0,
            proposalId: "transfer-a",
            sentAmount: 1,
            sourceLinkId: target.id,
            targetLinkId: "link-hub",
          },
        ],
      },
    };
    for (const overrides of [
      { linkRuntime: null },
      { logisticsEvidenceReady: false },
      { activeLogisticsTargetIds: new Set([target.id]) },
      { activeLogisticsTargetIds: new Set([replacement.id]) },
      { linkRuntime: activeTransfer },
      { room: withChangedLink(target.id, { active: false }) },
      { room: withChangedLink(target.id, { cooldown: 1 }) },
      { room: withChangedLink(replacement.id, { active: false }) },
      { room: withChangedLink(replacement.id, { cooldown: 1 }) },
      {
        room: withChangedLink(target.id, {
          store: {
            capacity: 800,
            freeCapacity: 799,
            resources: [{ amount: 1, resourceType: "energy" }],
            usedCapacity: 1,
          },
        }),
      },
      {
        room: withChangedLink(replacement.id, {
          store: {
            capacity: 800,
            freeCapacity: 799,
            resources: [{ amount: 1, resourceType: "energy" }],
            usedCapacity: 1,
          },
        }),
      },
      {
        linkRuntime: {
          ...fixture.linkRuntime,
          classification: {
            ...fixture.linkRuntime.classification,
            blockers: [{ id: target.id, reason: "stale-link" as const }],
          },
        },
      },
      { linkRuntime: { ...fixture.linkRuntime, layoutRevision: "stale-layout" } },
      {
        currentPlacements: [...fixture.currentPlacements, duplicatePlacement],
      },
    ])
      expect(
        planMigration({
          activeLogisticsTargetIds: new Set(),
          colony: fixture.colony,
          currentPlacements: fixture.currentPlacements,
          linkRuntime: fixture.linkRuntime,
          logisticsEvidenceReady: true,
          placements: fixture.idealPlacements,
          room: fixture.room,
          ...overrides,
        }).proposals,
      ).toEqual([]);
  });

  it("persists and completes one stocked obsolete reserve-link evacuation before removal", () => {
    const stagedFixture = reserveLinkMigrationFixture(300, 0, 100);
    const staged = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony: stagedFixture.colony,
      currentPlacements: stagedFixture.currentPlacements,
      linkRuntime: stagedFixture.linkRuntime,
      logisticsEvidenceReady: true,
      placements: stagedFixture.idealPlacements,
      room: stagedFixture.room,
    });
    expect(staged.proposals).toEqual([]);
    expect(staged.blockers).toContainEqual({
      reason: "target-stocked",
      roomName: "W1N1",
      targetId: "link-reserve-external",
    });
    expect(staged.linkEvacuation).toEqual({
      amount: 300,
      expiresAt: 250,
      replacementId: "link-reserve-exact",
      replacementInitialEnergy: 0,
      sourceId: "link-reserve-external",
      startedAt: 100,
    });
    const evacuation = staged.linkEvacuation;
    if (evacuation === null) throw new Error("expected link evacuation");
    const flowId = layoutLinkEvacuationFlowId("W1N1", evacuation);
    if (flowId === null) throw new Error("expected bounded link evacuation identity");

    const partialFixture = reserveLinkMigrationFixture(100, 200, 101);
    const partial = planMigration({
      activeLogisticsFlowIds: new Set([flowId]),
      activeLogisticsTargetIds: new Set(["link-reserve-external", "link-reserve-exact"]),
      colony: partialFixture.colony,
      currentPlacements: [...partialFixture.currentPlacements].reverse(),
      linkEvacuation: JSON.parse(JSON.stringify(evacuation)) as typeof evacuation,
      linkRuntime: partialFixture.linkRuntime,
      logisticsEvidenceReady: true,
      placements: [...partialFixture.idealPlacements].reverse(),
      room: {
        ...partialFixture.room,
        ownedLinks: [...(partialFixture.room.ownedLinks ?? [])].reverse(),
        structures: [...(partialFixture.room.structures ?? [])].reverse(),
      },
    });
    expect(partial.proposals).toEqual([]);
    expect(partial.linkEvacuation).toEqual(evacuation);

    const completeFixture = reserveLinkMigrationFixture(0, 300, 102);
    const complete = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony: completeFixture.colony,
      currentPlacements: completeFixture.currentPlacements,
      linkEvacuation: evacuation,
      linkRuntime: completeFixture.linkRuntime,
      logisticsEvidenceReady: true,
      placements: completeFixture.idealPlacements,
      room: completeFixture.room,
    });
    expect(complete.proposals).toEqual([
      expect.objectContaining({
        replacementExpectedEnergy: 300,
        replacementId: "link-reserve-exact",
        targetId: "link-reserve-external",
        targetStructureType: "link",
      }),
    ]);
    expect(complete.linkEvacuation).toEqual(evacuation);
  });

  it("keeps an operational committed tower before proposing one empty obsolete tower", () => {
    const towerPolicy = projectColonyRclPolicy({
      activeThreat: false,
      controllerLevel: 5,
      controllerRisk: false,
      cpuMode: "normal",
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      protectedSpawnEnergy: 300,
      rcl8Health: null,
      state: "developing",
      visibility: "visible",
    });
    const colony = { ...migrationColony(), rclPolicy: towerPolicy } as ColonyView;
    const placements = [placement("tower", 15, 15), placement("tower", 16, 15)];
    const tower = (id: string, x: number, energy: number, active = true) => ({
      active,
      hits: 3_000,
      hitsMax: 3_000,
      id,
      pos: { roomName: "W1N1", x, y: 15 },
      store: {
        capacity: 1_000,
        freeCapacity: 1_000 - energy,
        resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
        usedCapacity: energy,
      },
    });
    const exact = tower("tower-exact", 15, 10);
    const obsolete = tower("tower-obsolete", 30, 0);
    const room = (towers: readonly ReturnType<typeof tower>[]) =>
      ({
        ...migrationRoom(),
        controller: { level: 5, ownership: "owned" as const },
        ownedTowers: towers,
        structures: towers.map((value) =>
          structure(value.id, "tower", 3_000, 3_000, value.pos.x, value.pos.y),
        ),
      }) as unknown as RoomSnapshot;
    const ready = planMigration({ colony, placements, room: room([exact, obsolete]) });
    const reordered = planMigration({
      colony,
      placements: [...placements].reverse(),
      room: room([obsolete, exact]),
    });

    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: "tower-exact",
        replacementStructureType: "tower",
        targetId: "tower-obsolete",
        targetRequiresEmptyStore: true,
        targetStructureType: "tower",
      }),
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(ready));
    for (const blocked of [
      room([tower("tower-exact", 15, 9), obsolete]),
      room([exact, tower("tower-obsolete", 30, 1)]),
      room([tower("tower-exact", 15, 10, false), obsolete]),
      room([obsolete]),
    ])
      expect(planMigration({ colony, placements, room: blocked }).proposals).toEqual([]);
  });

  it("removes one empty idle external lab only while current lab work is quiescent", () => {
    const desiredLabs = Array.from({ length: 10 }, (_, index) => ({
      ...placement("lab", 10 + (index % 4), 10 + Math.floor(index / 4)),
      adoption: "exact" as const,
      minimumRcl: 6,
    }));
    const ownedLabs = [
      ...desiredLabs
        .slice(0, 9)
        .map((item, index) => lab(`lab-exact-${String(index)}`, item.pos.x, item.pos.y)),
      lab("lab-external", 30, 30),
    ];
    const assignment = assignLabCluster({
      labs: ownedLabs,
      layoutFingerprint: fingerprintLabLayout("W1N1", ownedLabs),
      limits: { maximumBoostLabs: 2, maximumLabsScanned: 10, maximumOutputLabs: 8 },
      roomName: "W1N1",
    }).assignment;
    if (assignment === null) throw new Error("expected current lab assignment");
    const rclPolicy = projectColonyRclPolicy({
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
      ...migrationColony({ state: "mature" }),
      rclPolicy: {
        ...rclPolicy,
        progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
      },
    } as ColonyView;
    const room = {
      ...migrationRoom(),
      controller: { level: 8, ownership: "owned" as const },
      ownedLabs,
      structures: ownedLabs.map((item) =>
        structure(item.id, "lab", 500, 500, item.pos.x, item.pos.y),
      ),
    } as unknown as RoomSnapshot;
    const labMigration = {
      activity: [],
      assignment,
      limits: { maximumBoostLabs: 2, maximumLabsScanned: 10, maximumOutputLabs: 8 },
      observedAt: 100,
      quiescent: true,
      roomName: "W1N1",
    } as const;
    const ready = planMigration({
      activeLogisticsTargetIds: new Set(),
      colony,
      labMigration,
      logisticsEvidenceReady: true,
      placements: desiredLabs,
      room,
    });
    const reordered = planMigration({
      activeLogisticsTargetIds: new Set(),
      colony,
      labMigration,
      logisticsEvidenceReady: true,
      placements: [...desiredLabs].reverse(),
      room: {
        ...room,
        ownedLabs: [...ownedLabs].reverse(),
        structures: [...(room.structures ?? [])].reverse(),
      },
    });

    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementStructureType: "lab",
        targetId: "lab-external",
        targetRequiresEmptyStore: true,
        targetRequiresZeroCooldown: true,
        targetStructureType: "lab",
      }),
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(ready));
    const admittedLab = ready.proposals[0];
    if (admittedLab === undefined) throw new Error("expected lab removal proposal");
    const desiredExtensions = Array.from({ length: 60 }, (_, index) => ({
      ...placement("extension", 10 + (index % 20), 20 + Math.floor(index / 20)),
      adoption: "exact" as const,
      minimumRcl: 8,
    }));
    const extension = (id: string, x: number, y: number) => ({
      active: true,
      hits: 1_000,
      hitsMax: 1_000,
      id,
      pos: { roomName: "W1N1", x, y },
      store: { capacity: 200, freeCapacity: 200, resources: [], usedCapacity: 0 },
    });
    const exactExtensions = desiredExtensions
      .slice(0, 59)
      .map((item, index) => extension(`extension-exact-${String(index)}`, item.pos.x, item.pos.y));
    const externalExtension = extension("extension-obsolete", 1, 1);
    const mixedRoom = {
      ...room,
      ownedExtensions: [...exactExtensions, externalExtension],
      structures: [
        ...(room.structures ?? []),
        ...[...exactExtensions, externalExtension].map((item) =>
          structure(item.id, "extension", 1_000, 1_000, item.pos.x, item.pos.y),
        ),
      ],
    } as RoomSnapshot;
    const pendingReceipt = {
      attempt: 1,
      code: "OK" as const,
      nextEligibleTick: Number.MAX_SAFE_INTEGER,
      observedAt: 99,
      replacementId: admittedLab.replacementId,
      targetId: admittedLab.targetId,
      targetStructureType: "lab" as const,
    };
    expect(
      planMigration({
        activeLogisticsTargetIds: new Set(),
        colony,
        labMigration,
        logisticsEvidenceReady: true,
        placements: [...desiredExtensions, ...desiredLabs],
        removalReceipt: pendingReceipt,
        room: mixedRoom,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-pending", targetId: "lab-external" })],
      proposals: [],
      removalReceipt: pendingReceipt,
    });

    for (const overrides of [
      { labMigration: { ...labMigration, quiescent: false } },
      { activeLogisticsTargetIds: new Set(["lab-exact-0"]) },
      { labMigration: { ...labMigration, observedAt: 99 } },
      {
        room: {
          ...room,
          ownedLabs: ownedLabs.map((item) =>
            item.id === "lab-external" ? { ...item, cooldown: 1 } : item,
          ),
        } as RoomSnapshot,
      },
    ])
      expect(
        planMigration({
          activeLogisticsTargetIds: new Set(),
          colony,
          labMigration,
          logisticsEvidenceReady: true,
          placements: desiredLabs,
          room,
          ...overrides,
        }).proposals,
      ).toEqual([]);
  });

  it("persists and completes one energy-only quiescent-lab evacuation before removal", () => {
    const fixture = labEvacuationFixture(750, 250, 100);
    const staged = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony: fixture.colony,
      labMigration: fixture.labMigration,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: fixture.room,
    });

    expect(staged.proposals).toEqual([]);
    expect(staged.blockers).toContainEqual({
      reason: "target-stocked",
      roomName: "W1N1",
      targetId: "lab-external",
    });
    expect(staged.labEvacuation).toEqual({
      amount: 750,
      expiresAt: 250,
      replacementId: fixture.replacementId,
      replacementInitialEnergy: 250,
      sourceId: "lab-external",
      startedAt: 100,
    });
    const evacuation = staged.labEvacuation;
    if (evacuation === null) throw new Error("expected lab evacuation");
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", migrationCommitment);
    owner = persistLayoutLabEvacuation(owner, "W1N1", evacuation);
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const persistedEvacuation = owner.records[0]?.labEvacuation;
    if (persistedEvacuation === undefined) throw new Error("expected persisted lab evacuation");
    const following = labEvacuationFixture(750, 250, 101, fixture.replacementId);
    const logistics = projectLayoutLabEvacuations({
      existingBudgets: [],
      migrationRooms: [following.labMigration],
      records: owner.records,
      snapshot: { rooms: [following.room] } as unknown as WorldSnapshot,
      tick: 101,
    });
    const flowId = layoutLabEvacuationFlowId("W1N1", persistedEvacuation);
    if (flowId === null) throw new Error("expected bounded lab flow identity");
    expect(logistics).toMatchObject({
      authorizedFlowIds: [flowId],
      budgets: [expect.objectContaining({ category: "optional-growth" })],
      demands: { edges: [expect.objectContaining({ id: flowId, maximumAmount: 750 })] },
    });

    const partial = labEvacuationFixture(300, 700, 102, fixture.replacementId);
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set([flowId]),
        activeLogisticsTargetIds: new Set(["lab-external", fixture.replacementId]),
        colony: partial.colony,
        labEvacuation: JSON.parse(JSON.stringify(persistedEvacuation)) as typeof evacuation,
        labMigration: partial.labMigration,
        logisticsEvidenceReady: true,
        placements: [...partial.placements].reverse(),
        room: {
          ...partial.room,
          ownedLabs: [...(partial.room.ownedLabs ?? [])].reverse(),
          structures: [...(partial.room.structures ?? [])].reverse(),
        },
      }),
    ).toMatchObject({ labEvacuation: evacuation, proposals: [] });

    const completeFixture = labEvacuationFixture(0, 1_000, 103, fixture.replacementId);
    const complete = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony: completeFixture.colony,
      labEvacuation: evacuation,
      labMigration: completeFixture.labMigration,
      logisticsEvidenceReady: true,
      placements: completeFixture.placements,
      room: completeFixture.room,
    });
    expect(complete.proposals).toEqual([
      expect.objectContaining({
        replacementId: fixture.replacementId,
        targetId: "lab-external",
        targetStructureType: "lab",
      }),
    ]);
    expect(complete.labEvacuation).toEqual(evacuation);
    if (complete.authorization === null) throw new Error("expected lab removal authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [complete.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: complete.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: "W1N1" } as unknown as Room;
    const liveLabs = completeFixture.room.ownedLabs ?? [];
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) => {
        const value = liveLabs.find((candidate) => candidate.id === id);
        if (value === undefined) return null;
        return {
          cooldown: value.cooldown,
          destroy: id === "lab-external" ? destroy : vi.fn(() => 0),
          id: value.id,
          isActive: () => value.active,
          mineralType: value.mineralType,
          my: true,
          pos: value.pos,
          room: liveRoom,
          store: {
            getCapacity: (resource?: string) =>
              resource === "energy" ? 2_000 : resource === undefined ? null : 3_000,
            getFreeCapacity: (resource?: string) =>
              resource === "energy" ? 2_000 - value.energy : resource === undefined ? null : 3_000,
            getUsedCapacity: (resource?: string) =>
              resource === "energy" || resource === undefined ? value.energy : 0,
          },
          structureType: "lab",
        } as unknown as Structure;
      },
    });
    owner = reconcileStructureDestroyExecution(owner, execution, 103).owner;
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const receipt = owner.records[0]?.removalReceipt ?? null;
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();
    expect(owner.records[0]?.labEvacuation).toEqual(evacuation);

    const pendingFixture = labEvacuationFixture(0, 1_000, 104, fixture.replacementId);
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony: pendingFixture.colony,
        labEvacuation: owner.records[0]?.labEvacuation ?? null,
        labMigration: pendingFixture.labMigration,
        logisticsEvidenceReady: true,
        placements: pendingFixture.placements,
        removalReceipt: receipt,
        room: pendingFixture.room,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-pending" })],
      proposals: [],
    });
    expect(destroy).toHaveBeenCalledOnce();

    const disappearedRoom = {
      ...pendingFixture.room,
      observedAt: 105,
      ownedLabs: (pendingFixture.room.ownedLabs ?? []).filter(({ id }) => id !== "lab-external"),
      structures: (pendingFixture.room.structures ?? []).filter(({ id }) => id !== "lab-external"),
    } as RoomSnapshot;
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony: pendingFixture.colony,
        labEvacuation: evacuation,
        labMigration: { ...pendingFixture.labMigration, observedAt: 105 },
        logisticsEvidenceReady: true,
        placements: pendingFixture.placements,
        removalReceipt: receipt,
        room: disappearedRoom,
      }),
    ).toMatchObject({ labEvacuation: null, proposals: [], removalReceipt: null });
    expect(
      diffOwnedRoomLayout({
        colonyId: "W1N1",
        commitment: migrationCommitment,
        commitmentConflicted: false,
        constructionSites: [],
        observationFingerprint: "observation-final",
        placements: pendingFixture.placements.map((placement) =>
          (disappearedRoom.structures ?? []).some(
            ({ pos }) => pos.x === placement.pos.x && pos.y === placement.pos.y,
          )
            ? placement
            : { ...placement, adoption: "planned" as const },
        ),
        policy: pendingFixture.colony.rclPolicy,
        policyEnabled: true,
        policyFingerprint: "policy-a",
        roomName: "W1N1",
        roomStatus: "owned",
        structures: disappearedRoom.structures ?? [],
      }).proposals,
    ).toEqual([expect.objectContaining({ structureType: "lab" })]);

    const overCapacity = labEvacuationFixture(1_000, 1_001, 100, fixture.replacementId);
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony: overCapacity.colony,
        labMigration: overCapacity.labMigration,
        logisticsEvidenceReady: true,
        placements: overCapacity.placements,
        room: overCapacity.room,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-capacity" })],
      labEvacuation: null,
      proposals: [],
    });

    for (const [targetEnergy, replacementEnergy] of [
      [751, 250],
      [0, 999],
    ] as const) {
      const drift = labEvacuationFixture(
        targetEnergy,
        replacementEnergy,
        102,
        fixture.replacementId,
      );
      expect(
        planMigration({
          activeLogisticsFlowIds: new Set(),
          activeLogisticsTargetIds: new Set(),
          colony: drift.colony,
          labEvacuation: evacuation,
          labMigration: drift.labMigration,
          logisticsEvidenceReady: true,
          placements: drift.placements,
          room: drift.room,
        }),
      ).toMatchObject({
        blockers: [expect.objectContaining({ reason: "evacuation-incomplete" })],
        labEvacuation: evacuation,
        proposals: [],
      });
    }

    const mineralFixture = labEvacuationFixture(750, 250, 100, fixture.replacementId);
    const mineralLabs = mineralFixture.room.ownedLabs;
    const mineralTarget = mineralLabs?.find(({ id }) => id === "lab-external");
    if (mineralLabs === undefined || mineralTarget === undefined)
      throw new Error("expected obsolete lab");
    const contaminatedTarget = {
      ...mineralTarget,
      mineralAmount: 50,
      mineralType: "H",
      store: {
        ...mineralTarget.store,
        resources: [
          { amount: 750, resourceType: "energy" },
          { amount: 50, resourceType: "H" },
        ],
        usedCapacity: 800,
      },
    };
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony: mineralFixture.colony,
        labMigration: mineralFixture.labMigration,
        logisticsEvidenceReady: true,
        placements: mineralFixture.placements,
        room: {
          ...mineralFixture.room,
          ownedLabs: mineralLabs.map((item) =>
            item.id === contaminatedTarget.id ? contaminatedTarget : item,
          ),
        },
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "target-stocked" })],
      labEvacuation: null,
      proposals: [],
    });

    const expired = labEvacuationFixture(100, 900, evacuation.expiresAt, fixture.replacementId);
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony: expired.colony,
        labEvacuation: evacuation,
        labMigration: expired.labMigration,
        logisticsEvidenceReady: true,
        placements: expired.placements,
        room: expired.room,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-expired" })],
      labEvacuation: null,
      proposals: [],
    });

    const activeIndustry = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony: completeFixture.colony,
      labEvacuation: evacuation,
      labMigration: { ...completeFixture.labMigration, quiescent: false },
      logisticsEvidenceReady: true,
      placements: completeFixture.placements,
      room: completeFixture.room,
    });
    expect(activeIndustry.proposals).toEqual([]);
    expect(activeIndustry.labEvacuation).toEqual(evacuation);
  });

  it("persists and completes one stocked obsolete-tower evacuation before removal", () => {
    const towerPolicy = projectColonyRclPolicy({
      activeThreat: false,
      controllerLevel: 5,
      controllerRisk: false,
      cpuMode: "normal",
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      protectedSpawnEnergy: 300,
      rcl8Health: null,
      state: "developing",
      visibility: "visible",
    });
    const colony = { ...migrationColony(), rclPolicy: towerPolicy } as ColonyView;
    const placements = [placement("tower", 15, 15), placement("tower", 16, 15)];
    const tower = (id: string, x: number, energy: number) => ({
      active: true,
      hits: 3_000,
      hitsMax: 3_000,
      id,
      pos: { roomName: "W1N1", x, y: 15 },
      store: {
        capacity: 1_000,
        freeCapacity: 1_000 - energy,
        resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
        usedCapacity: energy,
      },
    });
    const room = (targetEnergy: number, replacementEnergy: number, observedAt: number) => {
      const towers = [
        tower("tower-replacement", 15, replacementEnergy),
        tower("tower-obsolete", 30, targetEnergy),
      ];
      return {
        ...migrationRoom(),
        controller: { level: 5, ownership: "owned" as const },
        observedAt,
        ownedTowers: towers,
        structures: towers.map((value) =>
          structure(value.id, "tower", 3_000, 3_000, value.pos.x, value.pos.y),
        ),
      } as unknown as RoomSnapshot;
    };

    const staged = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony,
      logisticsEvidenceReady: true,
      placements,
      room: room(500, 10, 100),
    });
    expect(staged.proposals).toEqual([]);
    expect(staged.blockers).toContainEqual({
      reason: "target-stocked",
      roomName: "W1N1",
      targetId: "tower-obsolete",
    });
    expect(staged.towerEvacuation).toEqual({
      amount: 500,
      expiresAt: 250,
      replacementId: "tower-replacement",
      replacementInitialEnergy: 10,
      sourceId: "tower-obsolete",
      startedAt: 100,
    });
    const evacuation = staged.towerEvacuation;
    if (evacuation === null) throw new Error("expected tower evacuation");
    const flowId = layoutTowerEvacuationFlowId("W1N1", evacuation);
    if (flowId === null) throw new Error("expected bounded flow identity");

    const partialRoom = room(300, 210, 101);
    const partial = planMigration({
      activeLogisticsFlowIds: new Set([flowId]),
      activeLogisticsTargetIds: new Set(["tower-obsolete", "tower-replacement"]),
      colony,
      logisticsEvidenceReady: true,
      placements: [...placements].reverse(),
      room: {
        ...partialRoom,
        ownedTowers: [...partialRoom.ownedTowers].reverse(),
        structures: [...(partialRoom.structures ?? [])].reverse(),
      },
      towerEvacuation: JSON.parse(JSON.stringify(evacuation)) as typeof evacuation,
    });
    expect(partial.proposals).toEqual([]);
    expect(partial.towerEvacuation).toEqual(evacuation);

    const endpointActive = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(["tower-replacement"]),
      colony,
      logisticsEvidenceReady: true,
      placements,
      room: room(0, 510, 102),
      towerEvacuation: evacuation,
    });
    expect(endpointActive.proposals).toEqual([]);
    expect(endpointActive.blockers).toContainEqual({
      reason: "logistics-active",
      roomName: "W1N1",
      targetId: "tower-obsolete",
    });

    const complete = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony,
      logisticsEvidenceReady: true,
      placements,
      room: room(0, 510, 102),
      towerEvacuation: evacuation,
    });
    expect(complete.proposals).toEqual([
      expect.objectContaining({
        replacementId: "tower-replacement",
        targetId: "tower-obsolete",
        targetStructureType: "tower",
      }),
    ]);
    expect(complete.towerEvacuation).toEqual(evacuation);

    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony,
        logisticsEvidenceReady: true,
        placements,
        room: room(1_000, 10, 100),
      }).towerEvacuation,
    ).toBeNull();
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony,
        logisticsEvidenceReady: true,
        placements,
        room: room(501, 10, 101),
        towerEvacuation: evacuation,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-incomplete" })],
      proposals: [],
      towerEvacuation: evacuation,
    });
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

  it("evacuates one stocked redundant source container before removal", () => {
    const fixture = sourceContainerMigrationFixture();
    const target = sourceContainer("container-redundant", 10, 11, 50);
    const stockedRoom = {
      ...fixture.room,
      storedStructures: fixture.room.storedStructures.map((value) =>
        value.id === target.id ? target : value,
      ),
      structures: (fixture.room.structures ?? []).map((value) =>
        value.id === target.id ? target : value,
      ),
    };
    const staged = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: stockedRoom,
    });

    expect(staged.proposals).toEqual([]);
    expect(staged.containerMigration).toEqual({
      energyAmount: 50,
      expiresAt: 250,
      replacementId: "container-service",
      replacementInitialEnergy: 500,
      sourceId: "source-a",
      startedAt: 100,
      targetId: "container-redundant",
    });
    if (staged.containerMigration === null) throw new Error("expected source evacuation");
    const nextRoom = { ...stockedRoom, observedAt: 101 };
    const snapshot = {
      observation: { age: 0, shard: "shard0", status: "observed", tick: 101 },
      rooms: [nextRoom],
    } as unknown as WorldSnapshot;
    const projection = projectLayoutContainerMigrations({
      records: [
        {
          ...migrationCommitment,
          containerMigration: staged.containerMigration,
          roomName: "W1N1",
          sourceServices: fixture.placements,
        },
      ],
      snapshot,
      tick: 101,
    });
    expect(projection.edges).toEqual([
      expect.objectContaining({
        id: "layout-container-evacuation:W1N1:container-redundant:container-service",
        maximumAmount: 50,
      }),
    ]);
    expect(projection.suppressedSinkTargetIds).toEqual([
      "container-redundant",
      "container-service",
    ]);
    expect(projection.suppressedSourceTargetIds).toEqual(["container-redundant"]);
    expect(
      projectLayoutContainerMigrations({
        records: [
          {
            ...migrationCommitment,
            containerMigration: staged.containerMigration,
            roomName: "W1N1",
          },
        ],
        snapshot,
        tick: 101,
      }).edges,
    ).toEqual([]);
    const staticBefore = planStaticMining({
      layouts: new Map([["W1N1", fixture.placements]]),
      snapshot,
      tick: 101,
    });

    const emptiedTarget = sourceContainer("container-redundant", 10, 11, 0);
    const deliveredReplacement = sourceContainer("container-service", 11, 10, 550);
    const deliveredRoom = {
      ...stockedRoom,
      observedAt: 102,
      storedStructures: [emptiedTarget, deliveredReplacement],
      structures: [emptiedTarget, deliveredReplacement],
    };
    const activeFlowId = projection.edges[0]?.id;
    if (activeFlowId === undefined) throw new Error("expected source evacuation flow");
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set([activeFlowId]),
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: deliveredRoom,
      }).proposals,
    ).toEqual([]);
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set([deliveredReplacement.id]),
        containerMigration: staged.containerMigration,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: deliveredRoom,
      }).proposals,
    ).toEqual([]);
    const expiredUndeliveredRoom = {
      ...deliveredRoom,
      observedAt: staged.containerMigration.expiresAt,
      storedStructures: [emptiedTarget, sourceContainer("container-service", 11, 10, 500)],
      structures: [emptiedTarget, sourceContainer("container-service", 11, 10, 500)],
    };
    const expired = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      containerMigration: staged.containerMigration,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: expiredUndeliveredRoom,
    });
    expect(expired).toMatchObject({
      blockers: [expect.objectContaining({ reason: "migration-expired" })],
      containerMigration: staged.containerMigration,
      proposals: [],
    });
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        containerMigration: expired.containerMigration,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        room: { ...expiredUndeliveredRoom, observedAt: staged.containerMigration.expiresAt + 1 },
      }).proposals,
    ).toEqual([]);

    const removalReceipt = {
      attempt: 1,
      code: "ERR_BUSY" as const,
      nextEligibleTick: 104,
      observedAt: 102,
      replacementId: "container-service",
      targetId: "container-redundant",
      targetStructureType: "container" as const,
    };
    const backoff = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      containerMigration: staged.containerMigration,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      removalReceipt,
      room: deliveredRoom,
    });
    expect(backoff).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-backoff" })],
      proposals: [],
    });
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        removalReceipt,
        room: { ...deliveredRoom, observedAt: 104 },
      }).proposals,
    ).toHaveLength(1);
    expect(
      planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        containerMigration: staged.containerMigration,
        logisticsEvidenceReady: true,
        placements: fixture.placements,
        removalReceipt: { ...removalReceipt, attempt: 3 },
        room: { ...deliveredRoom, observedAt: 104 },
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-failed" })],
      proposals: [],
    });

    const ready = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      containerMigration: staged.containerMigration,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: deliveredRoom,
    });
    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: "container-service",
        targetId: "container-redundant",
      }),
    ]);
    const staticAfter = planStaticMining({
      layouts: new Map([["W1N1", [...fixture.placements].reverse()]]),
      snapshot: {
        ...snapshot,
        observation: { ...snapshot.observation, tick: 102 },
        rooms: [{ ...deliveredRoom, storedStructures: [deliveredReplacement] }],
      },
      tick: 102,
    });
    expect(staticAfter.projections[0]).toMatchObject({
      identity: staticBefore.projections[0]?.identity,
      workPosition: staticBefore.projections[0]?.workPosition,
    });
  });

  it("persists canonical mixed stock and rejects insufficient source-service capacity", () => {
    const fixture = sourceContainerMigrationFixture();
    const target = {
      ...sourceContainer("container-redundant", 10, 11, 50),
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
    const room = {
      ...fixture.room,
      storedStructures: fixture.room.storedStructures.map((value) =>
        value.id === target.id ? target : value,
      ),
      structures: (fixture.room.structures ?? []).map((value) =>
        value.id === target.id ? target : value,
      ),
    };
    const staged = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      logisticsEvidenceReady: true,
      placements: [...fixture.placements].reverse(),
      room,
    });
    expect(staged.containerMigration).toMatchObject({
      replacementId: "container-service",
      resourceManifest: [
        ["U", 25, 0],
        ["energy", 25, 500],
      ],
      sourceId: "source-a",
      targetId: "container-redundant",
    });
    expect(
      JSON.stringify(
        planMigration({
          activeLogisticsFlowIds: new Set(),
          activeLogisticsTargetIds: new Set(),
          logisticsEvidenceReady: true,
          placements: fixture.placements,
          room: {
            ...room,
            storedStructures: [...room.storedStructures].reverse(),
            structures: [...room.structures].reverse(),
          },
        }),
      ),
    ).toBe(JSON.stringify(staged));

    const fullReplacement = sourceContainer("container-service", 11, 10, 1_980);
    const capacityLost = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: {
        ...room,
        storedStructures: [target, fullReplacement],
        structures: [target, fullReplacement],
      },
    });
    expect(capacityLost.containerMigration).toBeNull();
    expect(capacityLost.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-capacity" }),
    );
    expect(capacityLost.proposals).toEqual([]);
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

    const singleNonEnergyTarget = {
      ...stockedTarget,
      store: {
        ...stockedTarget.store,
        resources: [{ amount: 50, resourceType: "U" }],
      },
    };
    const singleNonEnergyRoom = {
      ...fixture.room,
      storedStructures: fixture.room.storedStructures.map((value) =>
        value.id === singleNonEnergyTarget.id ? singleNonEnergyTarget : value,
      ),
      structures: (fixture.room.structures ?? []).map((value) =>
        value.id === singleNonEnergyTarget.id ? singleNonEnergyTarget : value,
      ),
    };
    const singleNonEnergy = planMigration({
      activeLogisticsTargetIds: new Set(),
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: singleNonEnergyRoom,
    });
    expect(singleNonEnergy.containerMigration).toMatchObject({
      replacementId: "container-general-b",
      resourceManifest: [["U", 50, 0]],
      targetId: "container-obsolete",
    });
    expect(singleNonEnergy.containerMigration).not.toHaveProperty("energyAmount");
    if (singleNonEnergy.containerMigration === null)
      throw new Error("expected single-resource migration");
    const malformedSingleNonEnergy = planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      containerMigration: {
        ...singleNonEnergy.containerMigration,
        resourceManifest: [["U", 50, 0, "unexpected"]],
      } as never,
      currentPlacements: fixture.currentPlacements,
      logisticsEvidenceReady: true,
      placements: fixture.placements,
      room: { ...singleNonEnergyRoom, observedAt: 101 },
    });
    expect(malformedSingleNonEnergy.blockers).toContainEqual(
      expect.objectContaining({ reason: "evacuation-incomplete" }),
    );
    const reorderedSingleNonEnergy = planMigration({
      activeLogisticsTargetIds: new Set(),
      currentPlacements: [...fixture.currentPlacements].reverse(),
      logisticsEvidenceReady: true,
      placements: [...fixture.placements].reverse(),
      room: {
        ...singleNonEnergyRoom,
        storedStructures: [...singleNonEnergyRoom.storedStructures].reverse(),
        structures: [...singleNonEnergyRoom.structures].reverse(),
      },
    });
    expect(JSON.stringify(reorderedSingleNonEnergy)).toBe(JSON.stringify(singleNonEnergy));

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

function reserveLinkMigrationFixture(targetEnergy = 0, replacementEnergy = 0, observedAt = 100) {
  const sourceServices: LayoutPlacement[] = [
    {
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: { roomName: "W1N1", x: 10, y: 10 },
      service: { kind: "source-container", sourceId: "source-a" },
      structureType: "container",
    },
    {
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: { roomName: "W1N1", x: 40, y: 10 },
      service: { kind: "source-container", sourceId: "source-b" },
      structureType: "container",
    },
  ];
  const linkPlacement = (
    x: number,
    y: number,
    adoption: LayoutPlacement["adoption"] = "exact",
  ): LayoutPlacement => ({
    adoption,
    layer: "primary",
    minimumRcl: 5,
    pos: { roomName: "W1N1", x, y },
    structureType: "link",
  });
  const currentLinks = [
    linkPlacement(11, 10),
    linkPlacement(41, 10),
    linkPlacement(20, 21),
    linkPlacement(25, 25),
    linkPlacement(30, 30, "compatible-external"),
    linkPlacement(39, 40),
  ];
  const idealLinks = [
    linkPlacement(11, 10),
    linkPlacement(41, 10),
    linkPlacement(20, 21),
    linkPlacement(25, 25),
    linkPlacement(26, 25, "planned"),
    linkPlacement(39, 40),
  ];
  const link = (id: string, x: number, y: number, energy = 0) => ({
    active: true,
    cooldown: 0,
    hits: 1_000,
    hitsMax: 1_000,
    id,
    pos: { roomName: "W1N1", x, y },
    store: {
      capacity: 800,
      freeCapacity: 800 - energy,
      resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
      usedCapacity: energy,
    },
  });
  const ownedLinks = [
    link("link-source-a", 11, 10),
    link("link-source-b", 41, 10),
    link("link-hub", 20, 21),
    link("link-reserve-exact", 25, 25, replacementEnergy),
    link("link-reserve-external", 30, 30, targetEnergy),
    link("link-controller", 39, 40),
  ];
  const storage = {
    ...sourceContainer("storage-a", 20, 20, 0),
    ownership: "owned" as const,
    structureType: "storage",
    store: { capacity: 1_000_000, freeCapacity: 1_000_000, resources: [], usedCapacity: 0 },
  };
  const room = {
    ...migrationRoom(),
    observedAt,
    controller: {
      ...migrationRoom().controller,
      level: 8,
      pos: { roomName: "W1N1", x: 40, y: 40 },
    },
    ownedLinks,
    sources: [
      { id: "source-a", pos: { roomName: "W1N1", x: 10, y: 10 } },
      { id: "source-b", pos: { roomName: "W1N1", x: 40, y: 10 } },
    ],
    storedStructures: [storage],
    structures: [
      ...ownedLinks.map(({ id, pos }) => structure(id, "link", 1_000, 1_000, pos.x, pos.y)),
      storage,
    ],
  } as unknown as RoomSnapshot;
  const currentPlacements = [...sourceServices, ...currentLinks];
  const idealPlacements = [...sourceServices, ...idealLinks];
  const layoutRevision = `${migrationCommitment.algorithmRevision}:${migrationCommitment.fingerprint}`;
  const anchors = deriveLinkRoleAnchors({
    algorithmRevision: migrationCommitment.algorithmRevision,
    controller: { roomName: "W1N1", x: 40, y: 40 },
    fingerprint: migrationCommitment.fingerprint,
    linkPlacements: currentLinks.map(({ pos }) => pos),
    sourceServices: sourceServices.map((placement) => ({
      pos: placement.pos,
      sourceId: placement.service?.sourceId ?? "",
    })),
    storage: storage.pos,
  });
  const classification = classifyLinks({
    anchors,
    layoutRevision,
    links: ownedLinks.map((item) => ({
      active: item.active,
      cooldown: item.cooldown,
      energy: item.store.usedCapacity,
      freeCapacity: item.store.freeCapacity,
      id: item.id,
      observedAt: room.observedAt,
      owned: true,
      pos: item.pos,
    })),
    tick: room.observedAt,
  });
  const linkRuntime: LinkRoomRuntimeResult = {
    arbitration: arbitrateLinkTransfers({
      layoutRevision,
      links: classification.links,
      proposals: [],
      tick: room.observedAt,
    }),
    classification,
    layoutRevision,
    roomName: room.name,
  };
  const rclPolicy = projectColonyRclPolicy({
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
  return {
    colony: {
      ...migrationColony({ state: "mature" }),
      rclPolicy: {
        ...rclPolicy,
        progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
      },
    } as ColonyView,
    currentPlacements,
    idealPlacements,
    linkRuntime,
    room,
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
function lab(id: string, x: number, y: number, energy = 0) {
  return {
    active: true,
    cooldown: 0,
    energy,
    energyCapacity: 2_000,
    hits: 500,
    hitsMax: 500,
    id,
    mineralAmount: 0,
    mineralCapacity: 3_000,
    mineralType: null,
    pos: { roomName: "W1N1", x, y },
    store: {
      capacity: null,
      freeCapacity: null,
      resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
      usedCapacity: energy,
    },
  };
}

function labEvacuationFixture(
  targetEnergy: number,
  replacementEnergy: number,
  observedAt: number,
  requiredReplacementId?: string,
) {
  const placements = Array.from({ length: 10 }, (_, index) => ({
    ...placement("lab", 10 + (index % 4), 10 + Math.floor(index / 4)),
    adoption: "exact" as const,
    minimumRcl: 6,
  }));
  const exactLabs = placements
    .slice(0, 9)
    .map((item, index) => lab(`lab-exact-${String(index)}`, item.pos.x, item.pos.y));
  const postRemoval = assignLabCluster({
    labs: exactLabs,
    layoutFingerprint: fingerprintLabLayout("W1N1", exactLabs),
    limits: { maximumBoostLabs: 2, maximumLabsScanned: 10, maximumOutputLabs: 8 },
    roomName: "W1N1",
  }).assignment;
  if (postRemoval === null) throw new Error("expected post-removal lab assignment");
  const replacementId =
    requiredReplacementId ??
    [
      ...postRemoval.reagentLabIds,
      ...postRemoval.productLabIds,
      ...postRemoval.boostLabIds,
    ].sort()[0];
  if (replacementId === undefined) throw new Error("expected canonical lab replacement");
  const ownedLabs = [
    ...exactLabs.map((item) =>
      item.id === replacementId ? lab(item.id, item.pos.x, item.pos.y, replacementEnergy) : item,
    ),
    lab("lab-external", 30, 30, targetEnergy),
  ];
  const assignment = assignLabCluster({
    labs: ownedLabs,
    layoutFingerprint: fingerprintLabLayout("W1N1", ownedLabs),
    limits: { maximumBoostLabs: 2, maximumLabsScanned: 10, maximumOutputLabs: 8 },
    roomName: "W1N1",
  }).assignment;
  if (assignment === null) throw new Error("expected current lab assignment");
  const rclPolicy = projectColonyRclPolicy({
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
    ...migrationColony({ state: "mature" }),
    rclPolicy: {
      ...rclPolicy,
      progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
    },
  } as ColonyView;
  const room = {
    ...migrationRoom(),
    controller: { level: 8, ownership: "owned" as const },
    observedAt,
    ownedLabs,
    structures: ownedLabs.map((item) =>
      structure(item.id, "lab", 500, 500, item.pos.x, item.pos.y),
    ),
  } as unknown as RoomSnapshot;
  return {
    colony,
    labMigration: {
      activity: [],
      assignment,
      limits: { maximumBoostLabs: 2, maximumLabsScanned: 10, maximumOutputLabs: 8 },
      observedAt,
      quiescent: true,
      roomName: "W1N1",
    } as const,
    placements,
    replacementId,
    room,
  };
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
