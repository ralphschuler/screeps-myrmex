import { describe, expect, it, vi } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import { planStaticMining } from "../src/economy";
import { ConstructionPlanner } from "../src/maintenance";
import { projectLayoutContainerMigrations } from "../src/logistics/container-migration";
import type { WorldSnapshot } from "../src/world/snapshot";
import {
  CONSTRUCTION_SITE_LIMITS,
  STRUCTURE_REMOVAL_LIMITS,
  ConstructionSiteExecutor,
  StructureDestroyExecutor,
  arbitrateConstructionSites,
  arbitrateStructureRemovals,
  diffOwnedRoomLayout,
  emptyLayoutsOwner,
  persistLayoutCommitment,
  planOwnedRoomLayout,
  projectLayoutConvergencePlacements,
  reconcileConstructionSiteExecution,
  type LayoutPlacement,
} from "../src/layout";

const roomName = "W1N1",
  pos = (x: number, y: number) => ({ roomName, x, y });
const policy = projectColonyRclPolicy({
  activeThreat: false,
  controllerLevel: 3,
  controllerRisk: false,
  cpuMode: "normal",
  energyAvailable: 800,
  energyCapacityAvailable: 800,
  protectedSpawnEnergy: 300,
  rcl8Health: null,
  state: "developing",
  visibility: "visible",
});
const structures = [
  {
    hits: 5000,
    hitsMax: 5000,
    id: "spawn-a",
    ownerUsername: "me",
    ownership: "owned" as const,
    pos: pos(25, 25),
    structureType: "spawn",
  },
];
const planningInput = {
  constructionSites: [],
  controller: pos(20, 20),
  exits: [pos(0, 25)],
  mineral: null,
  policy,
  priorCommitment: null,
  roomName,
  sources: [{ ...pos(10, 10), sourceId: "source-a" }],
  structures,
  terrain: { cells: "0".repeat(2500), revision: "plain" },
  tick: 100,
} as const;
function complete() {
  const value = planOwnedRoomLayout(planningInput);
  if (value.status !== "complete") throw new Error("expected complete layout");
  return value;
}
function proposals(planned: ReturnType<typeof complete>) {
  return diffOwnedRoomLayout({
    colonyId: roomName,
    commitment: planned.commitment,
    commitmentConflicted: false,
    constructionSites: [],
    observationFingerprint: "obs-a",
    placements: planned.placements,
    policy,
    policyEnabled: true,
    policyFingerprint: "policy-a",
    roomName,
    roomStatus: "owned",
    structures,
  });
}
describe("composed layout runtime", () => {
  it("executes one accepted call, records OK, and suppresses the observed next-tick site", () => {
    const planned = complete(),
      diff = proposals(planned);
    const arbitration = arbitrateConstructionSites({
      globalOwnedSiteCount: 0,
      limits: CONSTRUCTION_SITE_LIMITS,
      perRoomSiteCounts: [{ count: 0, roomName }],
      priorReceipts: [],
      progressionAuthorizations: [{ authorized: true, colonyId: roomName, roomName }],
      proposals: diff.proposals,
      tick: 100,
    });
    expect(arbitration.accepted).toHaveLength(1);
    const createConstructionSite = vi.fn(() => 0);
    const execution = new ConstructionSiteExecutor().execute(arbitration.intents, {
      isCurrentCommitment: (_room, fingerprint) => fingerprint === planned.commitment.fingerprint,
      resolveRoom: () => ({ controller: { my: true }, createConstructionSite }) as unknown as Room,
    });
    expect(createConstructionSite).toHaveBeenCalledOnce();
    const reconciled = reconcileConstructionSiteExecution(
      persistLayoutCommitment(emptyLayoutsOwner(), roomName, planned.commitment),
      execution,
      100,
    );
    expect(reconciled.receipts[0]?.code).toBe("OK");
    const accepted = arbitration.intents[0];
    if (!accepted) throw new Error("missing intent");
    const next = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment: planned.commitment,
      commitmentConflicted: false,
      constructionSites: [
        {
          id: "site-a",
          ownerUsername: "me",
          ownership: "owned",
          pos: pos(accepted.x, accepted.y),
          progress: 0,
          progressTotal: 100,
          structureType: accepted.structureType,
        },
      ],
      observationFingerprint: "obs-b",
      placements: planned.placements,
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-a",
      roomName,
      roomStatus: "owned",
      structures,
    });
    expect(next.suppressed.some(({ reason }) => reason === "existing-owned-site")).toBe(true);
    expect(next.proposals.some(({ stableId }) => stableId === accepted.proposalId)).toBe(false);
    expect(JSON.stringify(next)).not.toMatch(/destroy|dismantle/);
  });
  it("admits no calls under caps and preserves a commitment on degradation", () => {
    const planned = complete(),
      proposal = proposals(planned).proposals.slice(0, 1);
    for (const pressure of [
      { globalOwnedSiteCount: 95, perRoomSiteCounts: [{ count: 0, roomName }] },
      { globalOwnedSiteCount: 0, perRoomSiteCounts: [{ count: 10, roomName }] },
    ])
      expect(
        arbitrateConstructionSites({
          ...pressure,
          limits: CONSTRUCTION_SITE_LIMITS,
          priorReceipts: [],
          progressionAuthorizations: [{ authorized: true, colonyId: roomName, roomName }],
          proposals: proposal,
          tick: 100,
        }).intents,
      ).toEqual([]);
    expect(
      planOwnedRoomLayout({
        ...planningInput,
        priorCommitment: planned.commitment,
        terrain: { cells: "", revision: "invalid" },
        tick: 101,
      }),
    ).toMatchObject({ commitment: planned.commitment, status: "degraded" });
  });
  it("is byte-identical after reset-style fact reordering", () => {
    expect(
      JSON.stringify(
        planOwnedRoomLayout({ ...planningInput, structures: [...structures].reverse() }),
      ),
    ).toBe(JSON.stringify(planOwnedRoomLayout(planningInput)));
  });

  it("builds desired extension capacity before removing one empty obsolete extension", () => {
    const idealExtensions = Array.from({ length: 10 }, (_, index) => ({
      adoption: "planned" as const,
      layer: "primary" as const,
      minimumRcl: 3,
      pos: pos(10 + index, 20),
      structureType: "extension",
    }));
    const commitment = { ...complete().commitment, fingerprint: "layout-extension-migration-a" };
    const extension = (id: string, x: number, y: number, usedCapacity = 0) => ({
      active: true,
      hits: 1_000,
      hitsMax: 1_000,
      id,
      pos: pos(x, y),
      store: {
        capacity: 50,
        freeCapacity: 50 - usedCapacity,
        resources: usedCapacity === 0 ? [] : [{ amount: usedCapacity, resourceType: "energy" }],
        usedCapacity,
      },
    });
    const structure = (id: string, x: number, y: number) => ({
      hits: 1_000,
      hitsMax: 1_000,
      id,
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: pos(x, y),
      structureType: "extension",
    });
    const exactBefore = Array.from({ length: 8 }, (_, index) =>
      extension(`extension-exact-${String(index)}`, 10 + index, 20),
    );
    const obsolete = extension("extension-obsolete", 30, 30);
    const room = (extensions: readonly ReturnType<typeof extension>[]) =>
      ({
        constructionSites: [],
        controller: { level: 3, ownership: "owned" as const },
        hostileCreeps: [],
        name: roomName,
        observedAt: 100,
        ownedCreeps: [],
        ownedExtensions: extensions,
        ownedSpawns: [],
        ownedTowers: [],
        roads: [],
        sources: [],
        storedStructures: [],
        structures: extensions.map(({ id, pos: extensionPos }) =>
          structure(id, extensionPos.x, extensionPos.y),
        ),
      }) as unknown as Parameters<ConstructionPlanner["planMigration"]>[0]["room"];
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      id: roomName,
      legalWorkforce: true,
      rclPolicy: policy,
      roomName,
      state: "developing",
      visibility: "visible",
    } as ColonyView;
    const beforeRoom = room([...exactBefore, obsolete]);
    const beforeDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-before",
      placements: idealExtensions,
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-a",
      roomName,
      roomStatus: "owned",
      structures: beforeRoom.structures ?? [],
    });
    const beforeMigration = new ConstructionPlanner().planMigration({
      colony,
      commitment,
      globalOwnedSiteCount: 0,
      observationFingerprint: "obs-before",
      placements: idealExtensions,
      policyFingerprint: "policy-a",
      room: beforeRoom,
    });

    expect(beforeDiff.proposals).toEqual([
      expect.objectContaining({ pos: pos(18, 20), structureType: "extension" }),
    ]);
    expect(beforeMigration.proposals).toEqual([]);

    const replacement = extension("extension-replacement", 18, 20);
    const readyRoom = room([...exactBefore, replacement, obsolete]);
    const planReady = (
      value: Parameters<ConstructionPlanner["planMigration"]>[0]["room"],
      extensionEvacuation: Parameters<
        ConstructionPlanner["planMigration"]
      >[0]["extensionEvacuation"] = null,
      activeLogisticsFlowIds: ReadonlySet<string> = new Set(),
    ) =>
      new ConstructionPlanner().planMigration({
        activeLogisticsFlowIds,
        colony,
        commitment,
        extensionEvacuation,
        globalOwnedSiteCount: 0,
        observationFingerprint: "obs-ready",
        placements: idealExtensions,
        policyFingerprint: "policy-a",
        room: value,
      });
    const ready = planReady(readyRoom);
    const reorderedReady = planReady({
      ...readyRoom,
      ownedExtensions: [...readyRoom.ownedExtensions].reverse(),
      structures: [...(readyRoom.structures ?? [])].reverse(),
    });
    const stockedRoom = room([
      ...exactBefore,
      replacement,
      extension("extension-obsolete", 30, 30, 50),
    ]);
    const sharedRoom = {
      ...readyRoom,
      structures: [
        ...(readyRoom.structures ?? []),
        {
          hits: 1,
          hitsMax: 300_000,
          id: "rampart-shared",
          ownerUsername: "me",
          ownership: "owned" as const,
          pos: obsolete.pos,
          structureType: "rampart",
        },
      ],
    };

    expect(JSON.stringify(reorderedReady)).toBe(JSON.stringify(ready));
    const evacuation = planReady(stockedRoom);
    expect(
      JSON.stringify(
        planReady({
          ...stockedRoom,
          ownedExtensions: [...stockedRoom.ownedExtensions].reverse(),
          structures: [...(stockedRoom.structures ?? [])].reverse(),
        }),
      ),
    ).toBe(JSON.stringify(evacuation));
    expect(evacuation.proposals).toEqual([]);
    expect(evacuation.extensionEvacuation).toMatchObject({
      amount: 50,
      replacementId: "extension-replacement",
      replacementInitialEnergy: 0,
      sourceId: "extension-obsolete",
    });
    if (evacuation.extensionEvacuation === null)
      throw new Error("expected extension evacuation commitment");
    const pendingFlowId = `layout-extension-evacuation:${roomName}:extension-obsolete:extension-replacement`;
    const emptiedRoom = room([
      ...exactBefore,
      replacement,
      extension("extension-obsolete", 30, 30),
    ]);
    expect(
      planReady(emptiedRoom, evacuation.extensionEvacuation, new Set([pendingFlowId])).proposals,
    ).toEqual([]);
    const expiredStocked = planReady(
      { ...stockedRoom, observedAt: evacuation.extensionEvacuation.expiresAt },
      evacuation.extensionEvacuation,
    );
    expect(expiredStocked).toMatchObject({
      blockers: [expect.objectContaining({ reason: "evacuation-expired" })],
      extensionEvacuation: null,
      proposals: [],
    });
    const expiredIncomplete = planReady(
      { ...emptiedRoom, observedAt: evacuation.extensionEvacuation.expiresAt },
      evacuation.extensionEvacuation,
    );
    expect(expiredIncomplete.extensionEvacuation).toEqual(evacuation.extensionEvacuation);

    const deliveredRoom = room([
      ...exactBefore,
      extension("extension-replacement", 18, 20, 50),
      extension("extension-obsolete", 30, 30),
    ]);
    expect(planReady(deliveredRoom, evacuation.extensionEvacuation).proposals).toEqual([
      expect.objectContaining({
        replacementId: "extension-replacement",
        targetId: "extension-obsolete",
      }),
    ]);
    expect(planReady(sharedRoom).proposals).toEqual([]);
    if (ready.authorization === null) throw new Error("expected extension migration authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveExtension = (value: ReturnType<typeof extension>, destroyCommand?: () => number) =>
      ({
        destroy: destroyCommand ?? vi.fn(() => 0),
        id: value.id,
        isActive: () => true,
        my: true,
        pos: value.pos,
        room: liveRoom,
        store: { getUsedCapacity: () => value.store.usedCapacity },
        structureType: "extension",
      }) as unknown as Structure;
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === obsolete.id
          ? liveExtension(obsolete, destroy)
          : id === replacement.id
            ? liveExtension(replacement)
            : null,
    });

    expect(arbitration.intents).toEqual([
      expect.objectContaining({
        replacementStructureType: "extension",
        targetId: "extension-obsolete",
        targetStructureType: "extension",
      }),
    ]);
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();

    const followingRoom = room([...exactBefore, replacement]);
    const following = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-following",
      placements: idealExtensions,
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-a",
      roomName,
      roomStatus: "owned",
      structures: followingRoom.structures ?? [],
    });
    expect(following.proposals).toEqual([
      expect.objectContaining({ pos: pos(19, 20), structureType: "extension" }),
    ]);
  });

  it("builds, drains logistics, and removes one obsolete general container", () => {
    const baseline = complete();
    const unlocks = policy.unlocks;
    if (unlocks === null) throw new Error("expected RCL unlocks");
    const desiredGeneral = baseline.placements.filter(
      ({ service, structureType }) => structureType === "container" && service === undefined,
    );
    const plannedService = baseline.placements.find(
      ({ service }) => service?.kind === "source-container",
    );
    if (desiredGeneral.length !== 4 || plannedService === undefined)
      throw new Error("expected one-source RCL3 container layout");
    const container = (id: string, position: ReturnType<typeof pos>, used = 0) => ({
      hits: 250_000,
      hitsMax: 250_000,
      id,
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: position,
      store: {
        capacity: 2_000,
        freeCapacity: 2_000 - used,
        resources: used === 0 ? [] : [{ amount: used, resourceType: "energy" }],
        usedCapacity: used,
      },
      structureType: "container",
      ticksToDecay: 5_000,
    });
    const sourceService = container("container-source", plannedService.pos, 500);
    const exactBefore = desiredGeneral
      .slice(0, 2)
      .map(({ pos: desiredPos }, index) =>
        container(`container-general-${String(index)}`, desiredPos),
      );
    const obsolete = container("container-obsolete", pos(35, 35), 50);
    const initialStructures = [...structures, sourceService, ...exactBefore, obsolete];
    const initial = planOwnedRoomLayout({ ...planningInput, structures: initialStructures });
    if (initial.status !== "complete") throw new Error("expected initial container layout");
    const initialConvergence = projectLayoutConvergencePlacements({
      commitment: initial.commitment,
      current: initial.placements,
      roomName,
      sourceCount: 1,
      sources: planningInput.sources,
      unlocks,
    });
    const initialDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment: initial.commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-container-before",
      placements: initialConvergence,
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-a",
      roomName,
      roomStatus: "owned",
      structures: initialStructures,
    });
    const replacementSite = initialDiff.proposals.find(
      ({ structureType }) => structureType === "container",
    );
    if (replacementSite === undefined) throw new Error("expected committed container site");
    const replacement = container("container-general-replacement", replacementSite.pos);
    const currentStructures = [...initialStructures, replacement];
    const current = planOwnedRoomLayout({ ...planningInput, structures: currentStructures });
    if (current.status !== "complete") throw new Error("expected replacement layout");
    const convergence = projectLayoutConvergencePlacements({
      commitment: current.commitment,
      current: current.placements,
      roomName,
      sourceCount: 1,
      sources: planningInput.sources,
      unlocks,
    });
    const room = {
      constructionSites: [],
      controller: { level: 3, ownership: "owned" as const },
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      hostileCreeps: [],
      name: roomName,
      observedAt: 100,
      ownedCreeps: [],
      ownedExtensions: [],
      ownedSpawns: [],
      ownedTowers: [],
      roads: [],
      sources: [
        {
          energy: 3_000,
          energyCapacity: 3_000,
          id: "source-a",
          pos: pos(10, 10),
          ticksToRegeneration: null,
        },
      ],
      storedStructures: [sourceService, ...exactBefore, replacement, obsolete],
      structures: currentStructures,
    } as unknown as Parameters<ConstructionPlanner["planMigration"]>[0]["room"];
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      id: roomName,
      legalWorkforce: true,
      rclPolicy: policy,
      roomName,
      state: "developing",
      visibility: "visible",
    } as ColonyView;
    const stage = new ConstructionPlanner().planMigration({
      activeLogisticsTargetIds: new Set(),
      colony,
      commitment: current.commitment,
      currentPlacements: current.placements,
      globalOwnedSiteCount: 0,
      logisticsEvidenceReady: true,
      observationFingerprint: "obs-container-ready",
      placements: convergence,
      policyFingerprint: "policy-a",
      room,
    });
    if (stage.containerMigration === null) throw new Error("expected container handoff");
    expect(stage.proposals).toEqual([]);
    expect(stage.containerMigration).toMatchObject({
      energyAmount: 50,
      replacementInitialEnergy: 0,
    });
    const nextRoom = { ...room, observedAt: 101 };
    const migrationProjection = projectLayoutContainerMigrations({
      existingBudgets: [],
      records: [
        {
          ...current.commitment,
          containerMigration: stage.containerMigration,
          roomName,
        },
      ],
      snapshot: {
        observation: { age: 0, shard: "shard0", status: "observed", tick: 101 },
        rooms: [nextRoom],
      } as unknown as WorldSnapshot,
      tick: 101,
    });
    expect(migrationProjection).toMatchObject({
      budgets: [expect.objectContaining({ category: "optional-growth" })],
      edges: [expect.objectContaining({ maximumAmount: 50 })],
    });
    const migrationFlowId =
      "layout-container-evacuation:W1N1:container-obsolete:container-general-replacement";
    expect(
      new ConstructionPlanner().planMigration({
        activeLogisticsFlowIds: new Set([migrationFlowId]),
        activeLogisticsTargetIds: new Set([obsolete.id]),
        colony,
        commitment: current.commitment,
        containerMigration: stage.containerMigration,
        currentPlacements: current.placements,
        globalOwnedSiteCount: 0,
        logisticsEvidenceReady: true,
        observationFingerprint: "obs-container-wait",
        placements: convergence,
        policyFingerprint: "policy-a",
        room: nextRoom,
      }).proposals,
    ).toEqual([]);
    const emptiedObsolete = container(obsolete.id, obsolete.pos);
    const stockedReplacement = container(replacement.id, replacement.pos, 50);
    const deliveredRoom = {
      ...nextRoom,
      storedStructures: nextRoom.storedStructures.map((value) =>
        value.id === obsolete.id
          ? emptiedObsolete
          : value.id === replacement.id
            ? stockedReplacement
            : value,
      ),
      structures: (nextRoom.structures ?? []).map((value) =>
        value.id === obsolete.id
          ? emptiedObsolete
          : value.id === replacement.id
            ? stockedReplacement
            : value,
      ),
    };
    const ready = new ConstructionPlanner().planMigration({
      activeLogisticsFlowIds: new Set(),
      activeLogisticsTargetIds: new Set(),
      colony,
      commitment: current.commitment,
      containerMigration: stage.containerMigration,
      currentPlacements: current.placements,
      globalOwnedSiteCount: 0,
      logisticsEvidenceReady: true,
      observationFingerprint: "obs-container-retired",
      placements: convergence,
      policyFingerprint: "policy-a",
      room: deliveredRoom,
    });
    if (ready.authorization === null) throw new Error("expected removal authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveContainer = (value: ReturnType<typeof container>, command = vi.fn(() => 0)) =>
      ({
        destroy: command,
        id: value.id,
        isActive: () => true,
        pos: value.pos,
        room: liveRoom,
        store: { getUsedCapacity: () => value.store.usedCapacity },
        structureType: "container",
      }) as unknown as Structure;
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) => {
        const value = deliveredRoom.storedStructures.find((candidate) => candidate.id === id);
        return value === undefined
          ? null
          : liveContainer(
              value as ReturnType<typeof container>,
              id === obsolete.id ? destroy : undefined,
            );
      },
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();

    const followingStructures = currentStructures.filter(({ id }) => id !== obsolete.id);
    const following = planOwnedRoomLayout({
      ...planningInput,
      structures: followingStructures,
      tick: 101,
    });
    if (following.status !== "complete") throw new Error("expected following layout");
    const followingConvergence = projectLayoutConvergencePlacements({
      commitment: following.commitment,
      current: following.placements,
      roomName,
      sourceCount: 1,
      sources: planningInput.sources,
      unlocks,
    });
    const followingDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment: following.commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-container-following",
      placements: followingConvergence,
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-a",
      roomName,
      roomStatus: "owned",
      structures: followingStructures,
    });
    expect(
      followingDiff.proposals.filter(({ structureType }) => structureType === "container"),
    ).toHaveLength(1);
    expect(
      following.placements.find(({ service }) => service?.sourceId === "source-a")?.pos,
    ).toEqual(current.placements.find(({ service }) => service?.sourceId === "source-a")?.pos);
  });

  it("removes one empty redundant source container without changing static mining", () => {
    const source = {
      energy: 3_000,
      energyCapacity: 3_000,
      id: "source-a",
      pos: pos(10, 10),
      ticksToRegeneration: null,
    };
    const container = (id: string, x: number, y: number, usedCapacity: number) => ({
      hits: 250_000,
      hitsMax: 250_000,
      id,
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: pos(x, y),
      store: {
        capacity: 2_000,
        freeCapacity: 2_000 - usedCapacity,
        resources: usedCapacity === 0 ? [] : [{ amount: usedCapacity, resourceType: "energy" }],
        usedCapacity,
      },
      structureType: "container",
      ticksToDecay: 500,
    });
    const replacement = container("container-service", 11, 10, 500);
    const redundant = container("container-redundant", 10, 11, 0);
    const planned = planOwnedRoomLayout({
      ...planningInput,
      structures: [...structures, redundant, replacement],
    });
    if (planned.status !== "complete") throw new Error("expected source-service layout");
    const sourceService = planned.placements.find(
      (placement) => placement.service?.sourceId === source.id,
    );
    if (sourceService === undefined) throw new Error("source service missing");
    const commitment = planned.commitment;
    const room = {
      constructionSites: [],
      controller: { level: 3, ownership: "owned" as const },
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      hostileCreeps: [],
      name: roomName,
      observedAt: 100,
      ownedCreeps: [],
      ownedExtensions: [],
      ownedSpawns: [],
      ownedTowers: [],
      roads: [],
      sources: [source],
      storedStructures: [redundant, replacement],
      structures: [...structures, redundant, replacement],
    } as unknown as Parameters<ConstructionPlanner["planMigration"]>[0]["room"];
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      id: roomName,
      legalWorkforce: true,
      rclPolicy: policy,
      roomName,
      state: "developing",
      visibility: "visible",
    } as ColonyView;
    expect(sourceService).toMatchObject({ adoption: "exact", pos: replacement.pos });
    const layouts = new Map([[roomName, [sourceService]]]);
    const staticBefore = planStaticMining({
      layouts,
      snapshot: {
        observation: { age: 0, shard: "shard0", status: "observed", tick: 100 },
        rooms: [room],
      } as unknown as WorldSnapshot,
      tick: 100,
    });
    const migration = new ConstructionPlanner().planMigration({
      colony,
      commitment,
      globalOwnedSiteCount: 0,
      observationFingerprint: "obs-container",
      placements: [sourceService],
      policyFingerprint: "policy-a",
      room,
    });
    if (migration.authorization === null) throw new Error("expected migration authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [migration.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: migration.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveContainer = (value: ReturnType<typeof container>, destroyCommand = vi.fn(() => 0)) =>
      ({
        destroy: destroyCommand,
        id: value.id,
        isActive: () => true,
        pos: value.pos,
        room: liveRoom,
        store: { getUsedCapacity: () => value.store.usedCapacity },
        structureType: "container",
      }) as unknown as Structure;
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === redundant.id
          ? liveContainer(redundant, destroy)
          : id === replacement.id
            ? liveContainer(replacement)
            : null,
    });

    expect(staticBefore.projections).toEqual([
      expect.objectContaining({
        identity: "mining/W1N1/source-a",
        workPosition: replacement.pos,
      }),
    ]);
    expect(staticBefore.requests).toHaveLength(1);
    expect(arbitration.intents).toEqual([
      expect.objectContaining({
        replacementId: replacement.id,
        targetId: redundant.id,
        targetStructureType: "container",
      }),
    ]);
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();

    const followingRoom = {
      ...room,
      observedAt: 101,
      storedStructures: [replacement],
      structures: [...structures, replacement],
    };
    const followingLayout = planOwnedRoomLayout({
      ...planningInput,
      priorCommitment: commitment,
      structures: [...structures, replacement],
      tick: 101,
    });
    if (followingLayout.status !== "complete") throw new Error("expected following layout");
    const followingSourceService = followingLayout.placements.find(
      (placement) => placement.service?.sourceId === source.id,
    );
    if (followingSourceService === undefined) throw new Error("following source service missing");
    const followingMigration = new ConstructionPlanner().planMigration({
      colony,
      commitment,
      globalOwnedSiteCount: 0,
      observationFingerprint: "obs-container-cleared",
      placements: [followingSourceService],
      policyFingerprint: "policy-a",
      room: followingRoom,
    });
    const staticAfter = planStaticMining({
      layouts: new Map([[roomName, [followingSourceService]]]),
      snapshot: {
        observation: { age: 0, shard: "shard0", status: "observed", tick: 101 },
        rooms: [followingRoom],
      } as unknown as WorldSnapshot,
      tick: 101,
    });
    expect(followingMigration.proposals).toEqual([]);
    expect(staticAfter.requests).toHaveLength(1);
    expect(staticAfter.projections[0]).toMatchObject({
      identity: staticBefore.projections[0]?.identity,
      workPosition: staticBefore.projections[0]?.workPosition,
    });
  });

  it("removes one temporary road then makes the planned tower eligible next observation", () => {
    const tower = {
      adoption: "planned",
      layer: "primary",
      minimumRcl: 3,
      pos: pos(15, 15),
      structureType: "tower",
    } as const satisfies LayoutPlacement;
    const road = {
      hits: 5_000,
      hitsMax: 5_000,
      id: "road-blocker",
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: pos(15, 15),
      structureType: "road",
      ticksToDecay: 1_000,
    };
    const commitment = { ...complete().commitment, fingerprint: "layout-migration-a" };
    const room = {
      constructionSites: [],
      controller: { level: 3, ownership: "owned" as const },
      hostileCreeps: [],
      name: roomName,
      observedAt: 100,
      ownedCreeps: [],
      ownedExtensions: [],
      ownedSpawns: [],
      ownedTowers: [],
      roads: [road],
      sources: [],
      storedStructures: [],
      structures: [road],
    } as unknown as Parameters<ConstructionPlanner["planMigration"]>[0]["room"];
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      id: roomName,
      legalWorkforce: true,
      rclPolicy: policy,
      roomName,
      state: "developing",
      visibility: "visible",
    } as ColonyView;
    const planning = new ConstructionPlanner().planMigration({
      colony,
      commitment,
      globalOwnedSiteCount: 0,
      observationFingerprint: "obs-road",
      placements: [tower],
      policyFingerprint: "policy-a",
      room,
    });
    if (planning.authorization === null) throw new Error("expected migration authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [planning.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: planning.proposals,
    });
    const destroy = vi.fn(() => 0);
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => ({ controller: { my: true }, name: roomName }) as unknown as Room,
      resolveStructure: () =>
        ({ ...road, destroy, room: { name: roomName } }) as unknown as Structure,
    });

    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();
    const following = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-cleared",
      placements: [tower],
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-a",
      roomName,
      roomStatus: "owned",
      structures: [],
    });
    expect(following.proposals).toEqual([
      expect.objectContaining({ structureType: "tower", pos: pos(15, 15) }),
    ]);
  });
});
