import { describe, expect, it } from "vitest";
import { ConstructionPlanner, DEFAULT_CONSTRUCTION_MAINTENANCE_POLICY } from "../src/maintenance";
import type { LayoutPlacement } from "../src/layout";
import type { WorldSnapshot } from "../src/world/snapshot";

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
