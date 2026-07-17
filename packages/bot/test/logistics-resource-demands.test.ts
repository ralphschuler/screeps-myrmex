import { describe, expect, it } from "vitest";
import type { LabClusterAssignment } from "../src/industry/lab-cluster";
import {
  projectLabResourceDemands,
  type LabResourceDemand,
  type LabResourceDemandLimits,
} from "../src/logistics/resource-demands";
import { emptyWorldSnapshot, type WorldSnapshot } from "../src/world/snapshot";

const LIMITS: LabResourceDemandLimits = {
  maximumAmountPerDemand: 3_000,
  maximumDemands: 16,
  maximumEdges: 16,
  maximumLabs: 10,
  maximumNodes: 32,
  maximumSourceStockPerNode: 5_000,
};

const ASSIGNMENT: LabClusterAssignment = {
  boostLabIds: ["lab-c"],
  fingerprint: "lab-cluster-v1:test",
  layoutFingerprint: "layout-v1:test",
  productLabIds: ["lab-c"],
  reagentLabIds: ["lab-a", "lab-b"],
  roomName: "W1N1",
};

describe("lab resource-demand projection", () => {
  it("projects bounded fill data with shared stock and separate lab capacities", () => {
    const result = project([
      demand("energy", { amount: 1_000, labId: "lab-c", resourceType: "energy" }),
      demand("mineral", { amount: 1_200, labId: "lab-c", resourceType: "UH" }),
    ]);

    expect(result.blockers).toEqual([]);
    expect(result.edges).toEqual([
      expect.objectContaining({
        budgetBinding: { category: "industry", issuer: "industry:energy" },
        id: "lab-demand:energy:r1:fill:energy",
        maximumAmount: 500,
      }),
      expect.objectContaining({
        budgetBinding: { category: "industry", issuer: "industry:mineral" },
        id: "lab-demand:mineral:r1:fill:UH",
        maximumAmount: 1_000,
      }),
    ]);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "lab:W1N1:lab-c:energy:energy", freeCapacity: 1_500 }),
        expect.objectContaining({ id: "lab:W1N1:lab-c:mineral:UH", freeCapacity: 2_800 }),
        expect.objectContaining({ id: "inventory:W1N1:storage:energy", observedAmount: 5_000 }),
        expect.objectContaining({ id: "inventory:W1N1:storage:UH", observedAmount: 2_000 }),
      ]),
    );
    expect(result.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "inventory:W1N1:storage:UH", targetId: "storage" }),
        expect.objectContaining({ nodeId: "lab:W1N1:lab-c:mineral:UH", targetId: "lab-c" }),
      ]),
    );
    expect(
      result.dispositions.map(({ demandId, remainingAmount }) => [demandId, remainingAmount]),
    ).toEqual([
      ["energy", 500],
      ["mineral", 1_000],
    ]);
  });

  it("drains incompatible mineral before projecting a requested fill", () => {
    const result = project([demand("replace", { amount: 1_000, resourceType: "U" })], {
      labAMineral: { amount: 300, type: "H" },
    });

    expect(result.edges).toEqual([
      expect.objectContaining({
        id: "lab-demand:replace:r1:drain:H",
        maximumAmount: 300,
        sinkNodeId: "inventory:W1N1:storage:H",
        sourceNodeId: "lab:W1N1:lab-a:mineral:H",
      }),
    ]);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capacityReservationKey: "inventory:W1N1:storage:aggregate-capacity",
          id: "inventory:W1N1:storage:H",
        }),
      ]),
    );
    expect(result.dispositions).toEqual([
      expect.objectContaining({
        effectiveMode: "drain",
        effectiveResourceType: "H",
        remainingAmount: 300,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('"command"');
    expect(JSON.stringify(result)).not.toContain('"contract"');
  });

  it("fails closed for stale, missing, inactive, and non-cluster lab facts", () => {
    const world = snapshot();
    const inactive = {
      ...world,
      ownedRooms: world.ownedRooms.map((room) => ({
        ...room,
        ownedLabs: room.ownedLabs?.map((lab) =>
          lab.id === "lab-a" ? { ...lab, active: false } : lab,
        ),
      })),
    } as WorldSnapshot;
    expect(
      projectLabResourceDemands({
        assignment: ASSIGNMENT,
        demands: [demand("stale", { clusterFingerprint: "old" })],
        limits: LIMITS,
        world,
      }).blockers,
    ).toEqual([expect.objectContaining({ reason: "stale-cluster-fingerprint" })]);
    expect(project([demand("missing", { labId: "lab-b" })], { omitLabB: true }).blockers).toEqual([
      expect.objectContaining({ reason: "missing-lab" }),
    ]);
    expect(
      projectLabResourceDemands({
        assignment: ASSIGNMENT,
        demands: [demand("inactive")],
        limits: LIMITS,
        world: inactive,
      }).blockers,
    ).toEqual([expect.objectContaining({ reason: "inactive-lab" })]);
    expect(project([demand("outside", { labId: "other-lab" })]).blockers).toEqual([
      expect.objectContaining({ reason: "non-cluster-lab" }),
    ]);
  });

  it("rejects duplicate identity/revision, expired deadlines, and bounded overflow", () => {
    const duplicate = project([demand("same"), demand("same")]);
    expect(duplicate.blockers).toEqual([
      { demandId: "same", reason: "duplicate-demand-revision", revision: 1 },
      { demandId: "same", reason: "duplicate-demand-revision", revision: 1 },
    ]);
    expect(project([demand("expired", { deadline: 99 })]).blockers).toEqual([
      expect.objectContaining({ reason: "expired-deadline" }),
    ]);
    expect(
      project([demand("a"), demand("b", { labId: "lab-b" })], {
        limits: { ...LIMITS, maximumDemands: 1 },
      }).blockers,
    ).toEqual([expect.objectContaining({ demandId: "b", reason: "demand-cap" })]);
    expect(project([demand("large", { amount: 3_001 })]).blockers).toEqual([
      expect.objectContaining({ reason: "invalid-demand" }),
    ]);
  });

  it("uses only active owned storage or terminal endpoints", () => {
    expect(project([demand("foreign", { endpointId: "foreign-store" })]).blockers).toEqual([
      expect.objectContaining({ reason: "missing-endpoint" }),
    ]);
    expect(project([demand("inactive", { endpointId: "terminal" })]).blockers).toEqual([
      expect.objectContaining({ reason: "inactive-endpoint" }),
    ]);
  });

  it("is canonical across reordered observations, demands, and heap-shaped clones", () => {
    const demands = [
      demand("z", { labId: "lab-c", resourceType: "energy" }),
      demand("a", { labId: "lab-b", resourceType: "H" }),
    ];
    const first = projectLabResourceDemands({
      assignment: ASSIGNMENT,
      demands,
      limits: LIMITS,
      world: snapshot(),
    });
    const reorderedWorld = snapshot();
    const room = reorderedWorld.ownedRooms[0];
    if (room === undefined) throw new Error("room fixture missing");
    const reset = projectLabResourceDemands({
      assignment: JSON.parse(JSON.stringify(ASSIGNMENT)) as LabClusterAssignment,
      demands: JSON.parse(JSON.stringify([...demands].reverse())) as LabResourceDemand[],
      limits: LIMITS,
      world: {
        ...reorderedWorld,
        ownedRooms: [{ ...room, ownedLabs: [...(room.ownedLabs ?? [])].reverse() }],
      },
    });
    expect(reset).toEqual(first);
  });
});

function project(
  demands: readonly LabResourceDemand[],
  options: SnapshotOptions & { readonly limits?: LabResourceDemandLimits } = {},
) {
  return projectLabResourceDemands({
    assignment: ASSIGNMENT,
    demands,
    limits: options.limits ?? LIMITS,
    world: snapshot(options),
  });
}

function demand(id: string, overrides: Partial<LabResourceDemand> = {}): LabResourceDemand {
  return {
    amount: 1_000,
    clusterFingerprint: ASSIGNMENT.fingerprint,
    colonyId: "W1N1",
    deadline: 150,
    endpointId: "storage",
    id,
    industryBudgetId: `industry:${id}`,
    labId: "lab-a",
    mode: "fill",
    priority: "normal",
    resourceType: "U",
    revision: 1,
    ...overrides,
  };
}

interface SnapshotOptions {
  readonly labAMineral?: { readonly amount: number; readonly type: string };
  readonly limits?: LabResourceDemandLimits;
  readonly omitLabB?: boolean;
}

function snapshot(options: SnapshotOptions = {}): WorldSnapshot {
  const base = emptyWorldSnapshot(100, "sim");
  const labs = [
    lab("lab-a", options.labAMineral?.type ?? null, options.labAMineral?.amount ?? 0, 10),
    lab("lab-b", null, 0, 12),
    lab("lab-c", "UH", 200, 11),
  ].filter(({ id }) => !(options.omitLabB === true && id === "lab-b"));
  const storageResources = [
    { amount: 10_000, resourceType: "energy" },
    { amount: 2_000, resourceType: "UH" },
    { amount: 1_000, resourceType: "U" },
    { amount: 1_000, resourceType: "H" },
  ];
  const room = {
    constructionSites: [],
    controller: { ownership: "owned" as const },
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    hostileCreeps: [],
    name: "W1N1",
    observedAt: 100,
    ownedCreeps: [],
    ownedExtensions: [],
    ownedLabs: labs,
    ownedSpawns: [],
    ownedStorages: [endpoint("storage", true, storageResources, 15)],
    ownedTerminals: [endpoint("terminal", false, storageResources, 16)],
    ownedTowers: [],
    sources: [],
    storedStructures: [
      {
        ...endpoint("foreign-store", true, storageResources, 17),
        hits: 1,
        hitsMax: 1,
        ownerUsername: "other",
        ownership: "foreign" as const,
        structureType: "storage",
      },
    ],
  };
  return {
    ...base,
    observation: { age: 0, shard: "sim", status: "observed", tick: 100 },
    observedAt: 100,
    ownedRooms: [room],
    rooms: [room],
  } as unknown as WorldSnapshot;
}

function lab(id: string, mineralType: string | null, mineralAmount: number, x: number) {
  return {
    active: true,
    cooldown: 0,
    energy: id === "lab-c" ? 500 : 0,
    energyCapacity: 2_000,
    hits: 500,
    hitsMax: 500,
    id,
    mineralAmount,
    mineralCapacity: 3_000,
    mineralType,
    pos: { roomName: "W1N1", x, y: 10 },
    store: {
      capacity: 5_000,
      freeCapacity: 5_000 - mineralAmount,
      resources: [],
      usedCapacity: mineralAmount,
    },
  };
}

function endpoint(
  id: string,
  active: boolean,
  resources: readonly { readonly amount: number; readonly resourceType: string }[],
  x: number,
) {
  const usedCapacity = resources.reduce((total, resource) => total + resource.amount, 0);
  return {
    active,
    cooldown: 0,
    hits: 1,
    hitsMax: 1,
    id,
    pos: { roomName: "W1N1", x, y: 10 },
    store: { capacity: 100_000, freeCapacity: 100_000 - usedCapacity, resources, usedCapacity },
  };
}
