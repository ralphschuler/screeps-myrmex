import { describe, expect, it } from "vitest";
import { COLONY_RCL_POLICY_TABLE } from "../src/colony/rcl-policy";
import {
  planOwnedRoomLayout,
  planOwnedRoomLayouts,
  selectLayoutPlanningWindow,
  type LayoutPlanningInput,
} from "../src/layout";

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
    if (first.status === "complete")
      expect(
        first.placements.some((p) => p.adoption === "exact" && p.structureType === "spawn"),
      ).toBe(true);
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
  ownership: "owned" | "foreign",
  roomName = "W1N1",
) {
  return {
    hits: 5000,
    hitsMax: 5000,
    id: `${structureType}-${String(x)}-${String(y)}`,
    ownerUsername: ownership === "owned" ? "Myrmex" : "Enemy",
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
