import { describe, expect, it, vi } from "vitest";
import { projectColonyRclPolicy, type ColonyView } from "../src/colony";
import { ConstructionPlanner } from "../src/maintenance";
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
