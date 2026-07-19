import { describe, expect, it, vi } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import { planStaticMining } from "../src/economy";
import { composeLabRuntime } from "../src/industry";
import { planLinkRuntime } from "../src/links";
import { ConstructionPlanner } from "../src/maintenance";
import { projectLayoutContainerMigrations } from "../src/logistics/container-migration";
import { projectLayoutLinkEvacuations } from "../src/logistics/link-evacuation";
import { projectLayoutTowerEvacuations } from "../src/logistics/tower-evacuation";
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
  layoutLinkEvacuationFlowId,
  parseLayoutsOwner,
  persistLayoutCommitment,
  persistLayoutLinkEvacuation,
  persistLayoutTowerEvacuation,
  planOwnedRoomLayout,
  projectLayoutConvergencePlacements,
  reconcileConstructionSiteExecution,
  reconcileStructureDestroyExecution,
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

  it("builds lab capacity, removes one quiescent empty external lab, and resumes canonical geometry", () => {
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
    const labPolicy = {
      ...projectedPolicy,
      progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
    } as ColonyView["rclPolicy"];
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      id: roomName,
      legalWorkforce: true,
      rclPolicy: labPolicy,
      roomName,
      state: "mature",
      visibility: "visible",
    } as ColonyView;
    const commitment = { ...complete().commitment, fingerprint: "layout-lab-migration-a" };
    const desiredLabs = Array.from({ length: 10 }, (_, index): LayoutPlacement => ({
      adoption: "planned",
      layer: "primary",
      minimumRcl: 6,
      pos: pos(10 + (index % 4), 10 + Math.floor(index / 4)),
      structureType: "lab",
    }));
    const lab = (id: string, position: ReturnType<typeof pos>) => ({
      active: true,
      cooldown: 0,
      energy: 0,
      energyCapacity: 2_000,
      hits: 500,
      hitsMax: 500,
      id,
      mineralAmount: 0,
      mineralCapacity: 3_000,
      mineralType: null,
      pos: position,
      store: { capacity: null, freeCapacity: null, resources: [], usedCapacity: 0 },
    });
    const generic = (value: ReturnType<typeof lab>) => ({
      hits: 500,
      hitsMax: 500,
      id: value.id,
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: value.pos,
      structureType: "lab",
    });
    const exactEight = desiredLabs
      .slice(0, 8)
      .map((placement, index) => lab(`lab-exact-${String(index)}`, placement.pos));
    const external = lab("lab-external", pos(30, 30));
    const initialLabs = [...exactEight, external];
    const initialDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-lab-100",
      placements: desiredLabs,
      policy: labPolicy,
      policyEnabled: true,
      policyFingerprint: "policy-lab",
      roomName,
      roomStatus: "owned",
      structures: initialLabs.map(generic),
    });
    expect(initialDiff.proposals).toEqual([expect.objectContaining({ structureType: "lab" })]);
    const builtSite = initialDiff.proposals[0];
    if (builtSite === undefined) throw new Error("expected committed lab site");
    const siteArbitration = arbitrateConstructionSites({
      globalOwnedSiteCount: 0,
      limits: CONSTRUCTION_SITE_LIMITS,
      perRoomSiteCounts: [{ count: 0, roomName }],
      priorReceipts: [],
      progressionAuthorizations: [{ authorized: true, colonyId: roomName, roomName }],
      proposals: initialDiff.proposals,
      tick: 100,
    });
    const createConstructionSite = vi.fn(() => 0);
    const siteExecution = new ConstructionSiteExecutor().execute(siteArbitration.intents, {
      isCurrentCommitment: () => true,
      resolveRoom: () => ({ controller: { my: true }, createConstructionSite }) as unknown as Room,
    });
    const siteOwner = reconcileConstructionSiteExecution(
      persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment),
      siteExecution,
      100,
    ).owner;
    expect(siteArbitration.intents).toEqual([expect.objectContaining({ structureType: "lab" })]);
    expect(createConstructionSite).toHaveBeenCalledOnce();
    expect(siteOwner.records[0]?.siteReceipts).toEqual([expect.objectContaining({ code: "OK" })]);
    const built = lab("lab-built", builtSite.pos);
    const tenLabs = [...exactEight, built, external];
    const room = (labs: readonly ReturnType<typeof lab>[], tick: number) =>
      ({
        constructionSites: [],
        controller: { level: 8, ownership: "owned" as const },
        hostileCreeps: [],
        name: roomName,
        observedAt: tick,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedLabs: labs,
        ownedSpawns: [],
        ownedTowers: [],
        roads: [],
        sources: [],
        storedStructures: [],
        structures: labs.map(generic),
      }) as unknown as WorldSnapshot["rooms"][number];
    const labsProjection = (labs: readonly ReturnType<typeof lab>[], tick: number) =>
      composeLabRuntime({
        fundedBudgetIds: new Set(),
        pendingAttempts: [],
        policy: buildRuntimeConfig().policy.industry,
        previousCommitments: [],
        reactionObjectives: [],
        reactions: {},
        reactionTimes: {},
        snapshot: {
          observation: { age: 0, shard: "shard0", status: "observed", tick },
          observedAt: tick,
          ownedRooms: [room(labs, tick)],
          rooms: [room(labs, tick)],
        } as unknown as WorldSnapshot,
        snapshotRevision: `snapshot/${String(tick)}`,
      });
    const plan = (
      labs: readonly ReturnType<typeof lab>[],
      tick: number,
      removalReceipt: Parameters<ConstructionPlanner["planMigration"]>[0]["removalReceipt"] = null,
    ) =>
      new ConstructionPlanner().planMigration({
        activeLogisticsFlowIds: new Set(),
        activeLogisticsTargetIds: new Set(),
        colony,
        commitment,
        globalOwnedSiteCount: 0,
        labMigration: labsProjection(labs, tick).migrationRooms[0] ?? null,
        logisticsEvidenceReady: true,
        observationFingerprint: `obs-lab-${String(tick)}`,
        placements: desiredLabs,
        policyFingerprint: "policy-lab",
        removalReceipt,
        room: room(labs, tick),
      });
    const ready = plan(tenLabs, 101);
    expect(ready.proposals).toEqual([
      expect.objectContaining({ targetId: external.id, targetStructureType: "lab" }),
    ]);
    if (ready.authorization === null) throw new Error("expected lab removal authorization");
    const arbitration = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    });
    const removalIntent = arbitration.intents[0];
    if (removalIntent === undefined) throw new Error("expected lab removal intent");
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveLab = (value: ReturnType<typeof lab>, command = vi.fn(() => 0)) => ({
      cooldown: value.cooldown,
      destroy: command,
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
          resource === "energy" ? 2_000 : resource === undefined ? null : 3_000,
        getUsedCapacity: () => 0,
      },
      structureType: "lab",
    });
    const execution = new StructureDestroyExecutor().execute(arbitration.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) => {
        const value = tenLabs.find((candidate) => candidate.id === id);
        return value === undefined
          ? null
          : (liveLab(value, id === external.id ? destroy : undefined) as unknown as Structure);
      },
    });
    let owner = reconcileStructureDestroyExecution(siteOwner, execution, 101).owner;
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const receipt = owner.records[0]?.removalReceipt ?? null;
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();
    expect(plan([...tenLabs].reverse(), 102, receipt)).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-pending" })],
      proposals: [],
    });
    expect(destroy).toHaveBeenCalledOnce();

    const postRemovalLabs = tenLabs.filter(({ id }) => id !== external.id);
    const following = plan(postRemovalLabs, 103, receipt);
    expect(following.removalReceipt).toBeNull();
    expect(labsProjection(postRemovalLabs, 103).assignments).toHaveLength(1);
    const finalDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-lab-103",
      placements: desiredLabs,
      policy: labPolicy,
      policyEnabled: true,
      policyFingerprint: "policy-lab",
      roomName,
      roomStatus: "owned",
      structures: postRemovalLabs.map(generic),
    });
    expect(finalDiff.proposals).toEqual([expect.objectContaining({ structureType: "lab" })]);
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
      removalReceipt: Parameters<ConstructionPlanner["planMigration"]>[0]["removalReceipt"] = null,
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
        removalReceipt,
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
    const delivered = planReady(deliveredRoom, evacuation.extensionEvacuation);
    expect(delivered.proposals).toEqual([
      expect.objectContaining({
        replacementId: "extension-replacement",
        targetId: "extension-obsolete",
      }),
    ]);
    const removalReceipt = {
      attempt: 1,
      code: "ERR_BUSY" as const,
      nextEligibleTick: 104,
      observedAt: 102,
      replacementId: "extension-replacement",
      targetId: "extension-obsolete",
      targetStructureType: "extension" as const,
    };
    const blocked = planReady(
      { ...deliveredRoom, observedAt: 103 },
      evacuation.extensionEvacuation,
      new Set(),
      removalReceipt,
    );
    expect(blocked).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-backoff" })],
      proposals: [],
      removalReceipt,
    });
    const sourceContainer = (id: string, x: number, y: number) => ({
      hits: 250_000,
      hitsMax: 250_000,
      id,
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: pos(x, y),
      store: { capacity: 2_000, freeCapacity: 2_000, resources: [], usedCapacity: 0 },
      structureType: "container",
      ticksToDecay: 5_000,
    });
    const laterReplacement = sourceContainer("container-later-service", 41, 40);
    const laterTarget = sourceContainer("container-later-target", 40, 41);
    const blockedWithLaterCandidate = new ConstructionPlanner().planMigration({
      colony,
      commitment,
      globalOwnedSiteCount: 0,
      observationFingerprint: "obs-ready",
      placements: [
        ...idealExtensions,
        {
          adoption: "exact",
          layer: "primary",
          minimumRcl: 2,
          pos: laterReplacement.pos,
          service: { kind: "source-container", sourceId: "source-later" },
          structureType: "container",
        },
      ],
      policyFingerprint: "policy-a",
      removalReceipt,
      room: {
        ...deliveredRoom,
        observedAt: 103,
        sources: [
          {
            energy: 3_000,
            energyCapacity: 3_000,
            id: "source-later",
            pos: pos(40, 40),
            ticksToRegeneration: null,
          },
        ],
        storedStructures: [laterReplacement, laterTarget],
        structures: [...(deliveredRoom.structures ?? []), laterReplacement, laterTarget],
      },
    });
    expect(blockedWithLaterCandidate).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-backoff" })],
      proposals: [],
      removalReceipt,
    });
    expect(
      planReady(
        { ...deliveredRoom, observedAt: 104 },
        evacuation.extensionEvacuation,
        new Set(),
        removalReceipt,
      ).proposals,
    ).toHaveLength(1);
    expect(
      planReady({ ...deliveredRoom, observedAt: 104 }, evacuation.extensionEvacuation, new Set(), {
        ...removalReceipt,
        code: "OK",
        nextEligibleTick: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-pending" })],
      proposals: [],
    });
    expect(
      planReady({ ...deliveredRoom, observedAt: 104 }, evacuation.extensionEvacuation, new Set(), {
        ...removalReceipt,
        replacementId: "extension-stale",
      }),
    ).toMatchObject({ proposals: [expect.anything()], removalReceipt: null });
    expect(
      planReady(
        {
          ...deliveredRoom,
          observedAt: 104,
          ownedExtensions: deliveredRoom.ownedExtensions.filter(
            ({ id }) => id !== "extension-obsolete",
          ),
          structures: (deliveredRoom.structures ?? []).filter(
            ({ id }) => id !== "extension-obsolete",
          ),
        },
        evacuation.extensionEvacuation,
        new Set(),
        { ...removalReceipt, code: "OK", nextEligibleTick: Number.MAX_SAFE_INTEGER },
      ).removalReceipt,
    ).toBeNull();
    if (delivered.authorization === null) throw new Error("expected delivered authorization");
    const deliveredProposal = delivered.proposals[0];
    if (deliveredProposal === undefined) throw new Error("expected delivered proposal");
    const otherProposal = {
      ...deliveredProposal,
      colonyId: "W2N2",
      pos: { roomName: "W2N2", x: 30, y: 30 },
      stableId: "remove-extension-v1:other-room",
    };
    expect(
      arbitrateStructureRemovals({
        authorizations: [
          delivered.authorization,
          {
            ...delivered.authorization,
            colonyId: "W2N2",
            roomName: "W2N2",
          },
        ],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: [...blocked.proposals, otherProposal],
      }).intents,
    ).toEqual([expect.objectContaining({ colonyId: "W2N2" })]);
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

    const executeBusy = (intents: typeof arbitration.intents) =>
      new StructureDestroyExecutor().execute(intents, {
        hasCurrentHostiles: () => false,
        isCurrentCommitment: () => true,
        resolveRoom: () => liveRoom,
        resolveStructure: (id) =>
          id === obsolete.id
            ? liveExtension(obsolete, () => -4)
            : id === replacement.id
              ? liveExtension(replacement)
              : null,
      });
    const failAttempt = (
      planned: ReturnType<typeof planReady>,
      owner: ReturnType<typeof emptyLayoutsOwner>,
      tick: number,
    ) => {
      if (planned.authorization === null) throw new Error("expected retry authorization");
      const retryArbitration = arbitrateStructureRemovals({
        authorizations: [planned.authorization],
        limits: STRUCTURE_REMOVAL_LIMITS,
        proposals: planned.proposals,
      });
      expect(retryArbitration.intents).toHaveLength(1);
      return reconcileStructureDestroyExecution(owner, executeBusy(retryArbitration.intents), tick)
        .owner;
    };
    let retryOwner = persistLayoutCommitment(
      emptyLayoutsOwner(),
      roomName,
      commitment,
      idealExtensions,
    );
    retryOwner = failAttempt(ready, retryOwner, 100);
    retryOwner = parseLayoutsOwner(JSON.parse(JSON.stringify(retryOwner))) ?? emptyLayoutsOwner();
    const retryReceiptOne = retryOwner.records[0]?.removalReceipt;
    expect(retryReceiptOne).toMatchObject({ attempt: 1, nextEligibleTick: 102 });
    expect(
      planReady({ ...readyRoom, observedAt: 101 }, null, new Set(), retryReceiptOne),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-backoff" })],
      proposals: [],
    });
    const reorderedRetryRoom = JSON.parse(
      JSON.stringify({
        ...readyRoom,
        observedAt: 102,
        ownedExtensions: [...readyRoom.ownedExtensions].reverse(),
        structures: [...(readyRoom.structures ?? [])].reverse(),
      }),
    ) as typeof readyRoom;
    retryOwner = failAttempt(
      planReady(reorderedRetryRoom, null, new Set(), retryReceiptOne),
      retryOwner,
      102,
    );
    retryOwner = parseLayoutsOwner(JSON.parse(JSON.stringify(retryOwner))) ?? emptyLayoutsOwner();
    const retryReceiptTwo = retryOwner.records[0]?.removalReceipt;
    expect(retryReceiptTwo).toMatchObject({ attempt: 2, nextEligibleTick: 106 });
    retryOwner = failAttempt(
      planReady({ ...readyRoom, observedAt: 106 }, null, new Set(), retryReceiptTwo),
      retryOwner,
      106,
    );
    const retryReceiptThree = retryOwner.records[0]?.removalReceipt;
    expect(retryReceiptThree).toMatchObject({
      attempt: 3,
      nextEligibleTick: Number.MAX_SAFE_INTEGER,
    });
    expect(
      planReady({ ...readyRoom, observedAt: 107 }, null, new Set(), retryReceiptThree),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-failed" })],
      proposals: [],
    });

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

  it("builds reserve capacity, evacuates stock, and removes one obsolete reserve link", () => {
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
    const linkPolicy = {
      ...projectedPolicy,
      progression: { authorized: true, reasonCode: "sustaining", status: "sustaining" },
    } as const;
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      id: roomName,
      legalWorkforce: true,
      rclPolicy: linkPolicy,
      roomName,
      state: "mature",
      visibility: "visible",
    } as ColonyView;
    const placement = (
      x: number,
      y: number,
      adoption: LayoutPlacement["adoption"] = "planned",
    ): LayoutPlacement => ({
      adoption,
      layer: "primary",
      minimumRcl: 8,
      pos: pos(x, y),
      structureType: "link",
    });
    const sourceServices: readonly LayoutPlacement[] = [
      {
        adoption: "exact",
        layer: "primary",
        minimumRcl: 2,
        pos: pos(10, 10),
        service: { kind: "source-container", sourceId: "source-a" },
        structureType: "container",
      },
      {
        adoption: "exact",
        layer: "primary",
        minimumRcl: 2,
        pos: pos(40, 10),
        service: { kind: "source-container", sourceId: "source-b" },
        structureType: "container",
      },
    ];
    const idealLinks = [
      placement(11, 10),
      placement(41, 10),
      placement(20, 21),
      placement(25, 25),
      placement(26, 25),
      placement(39, 40),
    ];
    const desiredPlacements = [...sourceServices, ...idealLinks];
    const commitment = { ...complete().commitment, fingerprint: "layout-reserve-link-a" };
    const link = (id: string, position: ReturnType<typeof pos>, energy = 0) => ({
      active: true,
      cooldown: 0,
      hits: 1_000,
      hitsMax: 1_000,
      id,
      pos: position,
      store: {
        capacity: 800,
        freeCapacity: 800 - energy,
        resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
        usedCapacity: energy,
      },
    });
    const storage = {
      hits: 10_000,
      hitsMax: 10_000,
      id: "storage-a",
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: pos(20, 20),
      store: { capacity: 1_000_000, freeCapacity: 1_000_000, resources: [], usedCapacity: 0 },
      structureType: "storage",
    };
    const external = link("link-reserve-external", pos(30, 30), 300);
    const critical = [
      link("link-source-a", pos(11, 10), 800),
      link("link-source-b", pos(41, 10)),
      link("link-hub", pos(20, 21)),
      link("link-controller", pos(39, 40)),
    ];
    const structureFacts = (links: readonly ReturnType<typeof link>[]) => [
      ...links.map((value) => ({
        hits: value.hits,
        hitsMax: value.hitsMax,
        id: value.id,
        ownerUsername: "me",
        ownership: "owned" as const,
        pos: value.pos,
        structureType: "link",
      })),
      storage,
    ];
    const room = (links: readonly ReturnType<typeof link>[], observedAt: number) =>
      ({
        constructionSites: [],
        controller: { level: 8, ownership: "owned" as const, pos: pos(40, 40) },
        hostileCreeps: [],
        name: roomName,
        observedAt,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedLinks: links,
        ownedSpawns: [],
        ownedTowers: [],
        roads: [],
        sources: [
          { id: "source-a", pos: pos(10, 10) },
          { id: "source-b", pos: pos(40, 10) },
        ],
        storedStructures: [storage],
        structures: structureFacts(links),
      }) as unknown as Parameters<ConstructionPlanner["planMigration"]>[0]["room"];

    const initialRoom = room([...critical, external], 100);
    const initialDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "link-before",
      placements: idealLinks,
      policy: linkPolicy,
      policyEnabled: true,
      policyFingerprint: "policy-link",
      roomName,
      roomStatus: "owned",
      structures: initialRoom.structures ?? [],
    });
    const siteArbitration = arbitrateConstructionSites({
      globalOwnedSiteCount: 0,
      limits: CONSTRUCTION_SITE_LIMITS,
      perRoomSiteCounts: [{ count: 0, roomName }],
      priorReceipts: [],
      progressionAuthorizations: [{ authorized: true, colonyId: roomName, roomName }],
      proposals: initialDiff.proposals,
      tick: 100,
    });
    const siteIntent = siteArbitration.intents[0];
    if (siteIntent === undefined) throw new Error("expected committed reserve-link site");
    expect(siteIntent.structureType).toBe("link");
    const reservePositions = new Set(["25,25", "26,25"]);
    expect(reservePositions.has(`${String(siteIntent.x)},${String(siteIntent.y)}`)).toBe(true);

    const replacement = link("link-reserve-exact", pos(siteIntent.x, siteIntent.y));
    const missingReserve = idealLinks.find(
      ({ pos: desired }) =>
        reservePositions.has(`${String(desired.x)},${String(desired.y)}`) &&
        (desired.x !== siteIntent.x || desired.y !== siteIntent.y),
    );
    if (missingReserve === undefined) throw new Error("expected the final reserve-link position");
    const currentLinks = idealLinks.map((value) =>
      value.pos.x === missingReserve.pos.x && value.pos.y === missingReserve.pos.y
        ? { ...value, adoption: "compatible-external" as const, pos: external.pos }
        : { ...value, adoption: "exact" as const },
    );
    const stockedRoom = room([...critical, replacement, external], 101);
    type MigrationInput = Parameters<ConstructionPlanner["planMigration"]>[0];
    const plan = (
      value: ReturnType<typeof room>,
      linkEvacuation: MigrationInput["linkEvacuation"] = null,
      removalReceipt: MigrationInput["removalReceipt"] = null,
      activeLogisticsFlowIds: ReadonlySet<string> = new Set(),
      activeLogisticsTargetIds: ReadonlySet<string> = new Set(),
      orderedCurrent: readonly LayoutPlacement[] = [...sourceServices, ...currentLinks],
      orderedDesired: readonly LayoutPlacement[] = desiredPlacements,
    ) => {
      const linkRuntime = planLinkRuntime({
        growth: [],
        layouts: [
          {
            evidence: {
              algorithmRevision: commitment.algorithmRevision,
              controller: pos(40, 40),
              fingerprint: commitment.fingerprint,
              linkPlacements: orderedCurrent
                .filter(({ structureType }) => structureType === "link")
                .map(({ pos: position }) => position),
              sourceServices: orderedCurrent.flatMap((current) =>
                current.service?.kind === "source-container"
                  ? [{ pos: current.pos, sourceId: current.service.sourceId }]
                  : [],
              ),
              storage: storage.pos,
            },
            roomName,
          },
        ],
        logistics: {
          budgets: [],
          contracts: { commitments: [], retirements: [] },
          graph: { edges: [], endpoints: [], nodes: [] },
          health: [],
          plan: { blockers: [], projections: [], recommendations: [], reservations: [] },
        },
        mining: { projections: [], replacements: [], requests: [], transitions: [] },
        reservations: [],
        rooms: [value],
        tick: value.observedAt,
      }).rooms[0];
      if (linkRuntime === undefined) throw new Error("expected public link-runtime evidence");
      expect(linkRuntime.arbitration.accepted).toEqual([]);
      return new ConstructionPlanner().planMigration({
        activeLogisticsFlowIds,
        activeLogisticsTargetIds,
        colony,
        commitment,
        currentPlacements: orderedCurrent,
        globalOwnedSiteCount: 0,
        linkEvacuation,
        linkRuntime,
        logisticsEvidenceReady: true,
        observationFingerprint: `link-${String(value.observedAt)}`,
        placements: orderedDesired,
        policyFingerprint: "policy-link",
        removalReceipt,
        room: value,
      });
    };
    const staged = plan(stockedRoom);
    expect(staged.proposals).toEqual([]);
    expect(staged.linkEvacuation).toMatchObject({
      amount: 300,
      replacementId: replacement.id,
      replacementInitialEnergy: 0,
      sourceId: external.id,
    });
    let owner = persistLayoutCommitment(
      emptyLayoutsOwner(),
      roomName,
      commitment,
      desiredPlacements,
    );
    owner = persistLayoutLinkEvacuation(owner, roomName, staged.linkEvacuation);
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const linkEvacuation = owner.records[0]?.linkEvacuation;
    if (linkEvacuation === undefined) throw new Error("expected persisted link evacuation");
    const authorizedFlowId = layoutLinkEvacuationFlowId(roomName, linkEvacuation);
    if (authorizedFlowId === null) throw new Error("expected bounded link evacuation identity");
    const logistics = projectLayoutLinkEvacuations({
      authorizedFlowIds: new Set([authorizedFlowId]),
      existingBudgets: [],
      records: owner.records,
      snapshot: { rooms: [stockedRoom] } as unknown as WorldSnapshot,
      tick: 101,
    });
    expect(logistics.budgets).toHaveLength(1);
    expect(logistics.demands.edges).toHaveLength(1);
    const flowId = logistics.demands.edges[0]?.id;
    if (flowId === undefined) throw new Error("expected link evacuation flow");

    const partialTarget = link(external.id, external.pos, 100);
    const partialReplacement = link(replacement.id, replacement.pos, 200);
    const partialRoom = room([...critical, partialReplacement, partialTarget], 102);
    expect(
      plan(
        partialRoom,
        linkEvacuation,
        null,
        new Set([flowId]),
        new Set([external.id, replacement.id]),
      ),
    ).toMatchObject({ proposals: [], linkEvacuation });

    const obsoleteEmpty = link(external.id, external.pos, 0);
    const deliveredReplacement = link(replacement.id, replacement.pos, 300);
    const readyRoom = room([...critical, deliveredReplacement, obsoleteEmpty], 103);
    const ready = plan(readyRoom, linkEvacuation);
    const resetReadyRoom = JSON.parse(
      JSON.stringify({
        ...readyRoom,
        ownedLinks: [...(readyRoom.ownedLinks ?? [])].reverse(),
        structures: [...(readyRoom.structures ?? [])].reverse(),
      }),
    ) as typeof readyRoom;
    const resetReady = plan(
      resetReadyRoom,
      JSON.parse(JSON.stringify(linkEvacuation)) as typeof linkEvacuation,
      null,
      new Set(),
      new Set(),
      [...sourceServices, ...currentLinks].reverse(),
      [...desiredPlacements].reverse(),
    );
    expect(JSON.stringify(resetReady)).toBe(JSON.stringify(ready));
    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementExpectedEnergy: 300,
        replacementId: replacement.id,
        targetId: external.id,
        targetStructureType: "link",
      }),
    ]);
    if (ready.authorization === null) throw new Error("expected reserve-link authorization");
    const removal = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveLink = (value: ReturnType<typeof link>, command = vi.fn(() => 0)) => ({
      cooldown: value.cooldown,
      destroy: command,
      id: value.id,
      isActive: () => value.active,
      my: true,
      pos: value.pos,
      room: liveRoom,
      store: {
        getCapacity: () => value.store.capacity,
        getFreeCapacity: () => value.store.freeCapacity,
        getUsedCapacity: (resource?: string) =>
          resource === undefined || resource === "energy" ? value.store.usedCapacity : 0,
      },
      structureType: "link",
    });
    const execution = new StructureDestroyExecutor().execute(removal.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === obsoleteEmpty.id
          ? (liveLink(obsoleteEmpty, destroy) as unknown as Structure)
          : id === deliveredReplacement.id
            ? (liveLink(deliveredReplacement) as unknown as Structure)
            : null,
    });
    owner = reconcileStructureDestroyExecution(owner, execution, 103).owner;
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const receipt = owner.records[0]?.removalReceipt ?? null;
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();
    expect(
      plan(room([...critical, deliveredReplacement, obsoleteEmpty], 104), linkEvacuation, receipt),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-pending" })],
      proposals: [],
    });
    expect(destroy).toHaveBeenCalledOnce();

    const followingRoom = room([...critical, deliveredReplacement], 105);
    expect(plan(followingRoom, linkEvacuation, receipt)).toMatchObject({
      linkEvacuation: null,
      removalReceipt: null,
    });
    const followingDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "link-following",
      placements: idealLinks,
      policy: linkPolicy,
      policyEnabled: true,
      policyFingerprint: "policy-link",
      roomName,
      roomStatus: "owned",
      structures: followingRoom.structures ?? [],
    });
    expect(followingDiff.proposals).toEqual([
      expect.objectContaining({ pos: missingReserve.pos, structureType: "link" }),
    ]);
  });

  it("builds a replacement, evacuates stock, and removes one obsolete tower", () => {
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
    const towerColony = {
      activeThreat: false,
      controllerRisk: false,
      id: roomName,
      legalWorkforce: true,
      rclPolicy: towerPolicy,
      roomName,
      state: "developing",
      visibility: "visible",
    } as ColonyView;
    const idealTowers: readonly LayoutPlacement[] = [
      {
        adoption: "planned",
        layer: "primary",
        minimumRcl: 3,
        pos: pos(15, 15),
        structureType: "tower",
      },
      {
        adoption: "planned",
        layer: "primary",
        minimumRcl: 5,
        pos: pos(16, 15),
        structureType: "tower",
      },
    ];
    const commitment = { ...complete().commitment, fingerprint: "layout-tower-migration-a" };
    const tower = (id: string, position: ReturnType<typeof pos>, energy: number) => ({
      active: true,
      hits: 3_000,
      hitsMax: 3_000,
      id,
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: position,
      store: {
        capacity: 1_000,
        freeCapacity: 1_000 - energy,
        resources: energy === 0 ? [] : [{ amount: energy, resourceType: "energy" }],
        usedCapacity: energy,
      },
      structureType: "tower",
    });
    const room = (towers: readonly ReturnType<typeof tower>[], observedAt: number) =>
      ({
        constructionSites: [],
        controller: { level: 5, ownership: "owned" as const },
        hostileCreeps: [],
        name: roomName,
        observedAt,
        ownedCreeps: [],
        ownedExtensions: [],
        ownedSpawns: [],
        ownedTowers: towers,
        roads: [],
        sources: [],
        storedStructures: [],
        structures: towers,
      }) as unknown as Parameters<ConstructionPlanner["planMigration"]>[0]["room"];
    const operational = (value: ReturnType<typeof room>) =>
      value.ownedTowers.some(
        ({ active, store }) =>
          active &&
          store.resources.some(
            ({ amount, resourceType }) => resourceType === "energy" && amount >= 10,
          ),
      );
    const obsoleteStocked = tower("tower-obsolete", pos(30, 30), 500);
    const initialRoom = room([obsoleteStocked], 100);
    const initialDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "tower-before",
      placements: idealTowers,
      policy: towerPolicy,
      policyEnabled: true,
      policyFingerprint: "policy-tower",
      roomName,
      roomStatus: "owned",
      structures: initialRoom.structures ?? [],
    });
    const siteArbitration = arbitrateConstructionSites({
      globalOwnedSiteCount: 0,
      limits: CONSTRUCTION_SITE_LIMITS,
      perRoomSiteCounts: [{ count: 0, roomName }],
      priorReceipts: [],
      progressionAuthorizations: [{ authorized: true, colonyId: roomName, roomName }],
      proposals: initialDiff.proposals,
      tick: 100,
    });
    const siteIntent = siteArbitration.intents[0];
    if (siteIntent === undefined) throw new Error("expected committed tower site");
    expect(siteIntent.structureType).toBe("tower");
    expect(operational(initialRoom)).toBe(true);

    const replacement = tower("tower-replacement", pos(siteIntent.x, siteIntent.y), 10);
    const stockedRoom = room([replacement, obsoleteStocked], 101);
    type MigrationInput = Parameters<ConstructionPlanner["planMigration"]>[0];
    const plan = (
      value: ReturnType<typeof room>,
      towerEvacuation: MigrationInput["towerEvacuation"] = null,
      removalReceipt: MigrationInput["removalReceipt"] = null,
      activeLogisticsFlowIds: ReadonlySet<string> = new Set(),
      activeLogisticsTargetIds: ReadonlySet<string> = new Set(),
    ) =>
      new ConstructionPlanner().planMigration({
        activeLogisticsFlowIds,
        activeLogisticsTargetIds,
        colony: towerColony,
        commitment,
        globalOwnedSiteCount: 0,
        logisticsEvidenceReady: true,
        observationFingerprint: `tower-${String(value.observedAt)}`,
        placements: idealTowers,
        policyFingerprint: "policy-tower",
        removalReceipt,
        room: value,
        towerEvacuation,
      });
    const staged = plan(stockedRoom);
    expect(staged.proposals).toEqual([]);
    expect(staged.towerEvacuation).toMatchObject({
      amount: 500,
      replacementId: "tower-replacement",
      replacementInitialEnergy: 10,
      sourceId: "tower-obsolete",
    });
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), roomName, commitment, idealTowers);
    owner = persistLayoutTowerEvacuation(owner, roomName, staged.towerEvacuation);
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const towerEvacuation = owner.records[0]?.towerEvacuation;
    if (towerEvacuation === undefined) throw new Error("expected persisted tower evacuation");
    const logistics = projectLayoutTowerEvacuations({
      existingBudgets: [],
      records: owner.records,
      snapshot: { rooms: [stockedRoom] } as unknown as WorldSnapshot,
      tick: 101,
    });
    expect(logistics.budgets).toHaveLength(1);
    expect(logistics.demands.edges).toHaveLength(1);
    const flowId = logistics.demands.edges[0]?.id;
    if (flowId === undefined) throw new Error("expected tower evacuation flow");

    const partialRoom = room(
      [
        tower("tower-obsolete", obsoleteStocked.pos, 250),
        tower("tower-replacement", replacement.pos, 260),
      ],
      102,
    );
    const partial = plan(
      partialRoom,
      towerEvacuation,
      null,
      new Set([flowId]),
      new Set(["tower-obsolete", "tower-replacement"]),
    );
    expect(partial.proposals).toEqual([]);
    expect(partial.towerEvacuation).toEqual(towerEvacuation);

    const deliveredReplacement = tower("tower-replacement", replacement.pos, 510);
    const obsoleteEmpty = tower("tower-obsolete", obsoleteStocked.pos, 0);
    const readyRoom = room([deliveredReplacement, obsoleteEmpty], 103);
    const ready = plan(readyRoom, towerEvacuation);
    const resetReadyRoom = JSON.parse(
      JSON.stringify({
        ...readyRoom,
        ownedTowers: [...readyRoom.ownedTowers].reverse(),
        structures: [...(readyRoom.structures ?? [])].reverse(),
      }),
    ) as typeof readyRoom;
    const resetReady = plan(
      resetReadyRoom,
      JSON.parse(JSON.stringify(towerEvacuation)) as typeof towerEvacuation,
    );
    expect(JSON.stringify(resetReady)).toBe(JSON.stringify(ready));
    expect(operational(initialRoom)).toBe(true);
    expect(operational(stockedRoom)).toBe(true);
    expect(operational(partialRoom)).toBe(true);
    expect(operational(readyRoom)).toBe(true);
    expect(ready.proposals).toEqual([
      expect.objectContaining({
        replacementId: "tower-replacement",
        targetId: "tower-obsolete",
        targetStructureType: "tower",
      }),
    ]);
    if (ready.authorization === null) throw new Error("expected tower removal authorization");
    const removal = arbitrateStructureRemovals({
      authorizations: [ready.authorization],
      limits: STRUCTURE_REMOVAL_LIMITS,
      proposals: ready.proposals,
    });
    const destroy = vi.fn(() => 0);
    const liveRoom = { controller: { my: true }, name: roomName } as unknown as Room;
    const liveTower = (value: ReturnType<typeof tower>, command = vi.fn(() => 0)) => ({
      destroy: command,
      id: value.id,
      isActive: () => value.active,
      my: true,
      pos: value.pos,
      room: liveRoom,
      store: {
        getUsedCapacity: (resource?: string) =>
          resource === undefined || resource === "energy" ? value.store.usedCapacity : 0,
      },
      structureType: "tower",
    });
    const execution = new StructureDestroyExecutor().execute(removal.intents, {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => liveRoom,
      resolveStructure: (id) =>
        id === obsoleteEmpty.id
          ? (liveTower(obsoleteEmpty, destroy) as unknown as Structure)
          : id === deliveredReplacement.id
            ? (liveTower(deliveredReplacement) as unknown as Structure)
            : null,
    });
    owner = reconcileStructureDestroyExecution(owner, execution, 103).owner;
    owner = parseLayoutsOwner(JSON.parse(JSON.stringify(owner))) ?? emptyLayoutsOwner();
    const receipt = owner.records[0]?.removalReceipt ?? null;
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(destroy).toHaveBeenCalledOnce();
    expect(
      plan(room([deliveredReplacement, obsoleteEmpty], 104), towerEvacuation, receipt),
    ).toMatchObject({
      blockers: [expect.objectContaining({ reason: "removal-pending" })],
      proposals: [],
    });

    const followingRoom = room([deliveredReplacement], 105);
    expect(operational(followingRoom)).toBe(true);
    expect(plan(followingRoom, towerEvacuation, receipt)).toMatchObject({
      removalReceipt: null,
      towerEvacuation: null,
    });
    const followingDiff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "tower-following",
      placements: idealTowers,
      policy: towerPolicy,
      policyEnabled: true,
      policyFingerprint: "policy-tower",
      roomName,
      roomStatus: "owned",
      structures: followingRoom.structures ?? [],
    });
    expect(followingDiff.proposals).toEqual([expect.objectContaining({ structureType: "tower" })]);
  });

  it("builds, evacuates one non-energy stock, and removes one obsolete general container", () => {
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
    const obsolete = {
      ...container("container-obsolete", pos(35, 35), 50),
      store: {
        capacity: 2_000,
        freeCapacity: 1_950,
        resources: [{ amount: 50, resourceType: "U" }],
        usedCapacity: 50,
      },
    };
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
    const replacement = {
      ...container("container-general-replacement", replacementSite.pos, 10),
      store: {
        capacity: 2_000,
        freeCapacity: 1_990,
        resources: [{ amount: 10, resourceType: "U" }],
        usedCapacity: 10,
      },
    };
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
      resourceManifest: [["U", 50, 10]],
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
    expect(migrationProjection.budgets).toEqual([
      expect.objectContaining({ category: "optional-growth" }),
    ]);
    expect(migrationProjection.edges).toEqual([expect.objectContaining({ maximumAmount: 50 })]);
    const migrationFlowIds = [
      "layout-container-evacuation:W1N1:container-obsolete:container-general-replacement:1:U",
    ];
    expect(
      new ConstructionPlanner().planMigration({
        activeLogisticsFlowIds: new Set(migrationFlowIds),
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
    const stockedReplacement = {
      ...container(replacement.id, replacement.pos, 60),
      store: {
        capacity: 2_000,
        freeCapacity: 1_940,
        resources: [{ amount: 60, resourceType: "U" }],
        usedCapacity: 60,
      },
    };
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

  it("creates compatible layered sites without destroying an existing road", () => {
    const tower = {
      adoption: "planned",
      layer: "primary",
      minimumRcl: 3,
      pos: pos(15, 15),
      structureType: "tower",
    } as const satisfies LayoutPlacement;
    const protectiveRampart = {
      adoption: "planned",
      layer: "rampart",
      minimumRcl: 3,
      pos: pos(16, 15),
      structureType: "rampart",
    } as const satisfies LayoutPlacement;
    const road = {
      hits: 5_000,
      hitsMax: 5_000,
      id: "road-compatible",
      ownerUsername: null,
      ownership: "unowned" as const,
      pos: pos(15, 15),
      structureType: "road",
      ticksToDecay: 1_000,
    };
    const existingRampart = {
      hits: 1,
      hitsMax: 1_000_000,
      id: "rampart-compatible",
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: pos(15, 15),
      structureType: "rampart",
    };
    const protectedSpawn = {
      hits: 5_000,
      hitsMax: 5_000,
      id: "spawn-protected",
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: pos(16, 15),
      structureType: "spawn",
    };
    const commitment = { ...complete().commitment, fingerprint: "layout-layering-a" };
    const currentStructures = [road, existingRampart, protectedSpawn];
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
    const placements = [tower, protectiveRampart];
    const project = (structures: readonly (typeof currentStructures)[number][]) => {
      const migration = new ConstructionPlanner().planMigration({
        colony,
        commitment,
        globalOwnedSiteCount: 0,
        observationFingerprint: "obs-road",
        placements,
        policyFingerprint: "policy-a",
        room: { ...room, structures },
      });
      const diff = diffOwnedRoomLayout({
        colonyId: roomName,
        commitment,
        commitmentConflicted: false,
        constructionSites: [],
        observationFingerprint: "obs-road",
        placements,
        policy,
        policyEnabled: true,
        policyFingerprint: "policy-a",
        roomName,
        roomStatus: "owned",
        structures,
      });
      const arbitration = arbitrateConstructionSites({
        globalOwnedSiteCount: 0,
        limits: CONSTRUCTION_SITE_LIMITS,
        perRoomSiteCounts: [{ count: 0, roomName }],
        priorReceipts: [],
        progressionAuthorizations: [{ authorized: true, colonyId: roomName, roomName }],
        proposals: diff.proposals,
        tick: 100,
      });
      return { arbitration, diff, migration };
    };
    const projected = project(currentStructures);
    const reordered = project([...currentStructures].reverse());
    const reconstructed = project(
      JSON.parse(JSON.stringify(currentStructures)) as typeof currentStructures,
    );
    expect(projected.migration.proposals).toEqual([]);
    expect(projected.diff.proposals.map(({ structureType }) => structureType)).toEqual([
      "tower",
      "rampart",
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(projected));
    expect(JSON.stringify(reconstructed)).toBe(JSON.stringify(projected));

    const createConstructionSite = vi.fn(() => 0);
    const execution = new ConstructionSiteExecutor().execute(projected.arbitration.intents, {
      isCurrentCommitment: () => true,
      resolveRoom: () => ({ controller: { my: true }, createConstructionSite }) as unknown as Room,
    });
    expect(execution).toEqual([expect.objectContaining({ called: true, code: "OK" })]);
    expect(createConstructionSite).toHaveBeenCalledWith(15, 15, "tower");

    const builtTower = {
      hits: 3_000,
      hitsMax: 3_000,
      id: "tower-built",
      ownerUsername: "me",
      ownership: "owned" as const,
      pos: pos(15, 15),
      structureType: "tower",
    };
    const followingInput = {
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [],
      observationFingerprint: "obs-built",
      placements,
      policy,
      policyEnabled: true,
      policyFingerprint: "policy-a",
      roomName,
      roomStatus: "owned" as const,
      structures: [road, existingRampart, builtTower, protectedSpawn],
    };
    const following = diffOwnedRoomLayout(followingInput);
    const followingReordered = diffOwnedRoomLayout({
      ...followingInput,
      placements: [...placements].reverse(),
      structures: [...followingInput.structures].reverse(),
    });
    expect(following.proposals).toEqual([
      expect.objectContaining({ structureType: "rampart", pos: pos(16, 15) }),
    ]);
    expect(following.suppressed).toEqual([
      expect.objectContaining({ reason: "existing-structure", placement: tower }),
    ]);
    expect(JSON.stringify(followingReordered)).toBe(JSON.stringify(following));
  });
});
