import { describe, expect, it } from "vitest";
import { assignLabCluster, normalizeReactionCatalog, type LabClusterLimits } from "../src/industry";
import type { OwnedLabSnapshot } from "../src/world/snapshot";

const LIMITS: LabClusterLimits = {
  maximumBoostLabs: 2,
  maximumLabsScanned: 10,
  maximumOutputLabs: 8,
};

describe("lab cluster facts and roles", () => {
  it.each([3, 6, 10])("assigns deterministic roles for a valid %i-lab geometry", (count) => {
    const labs = Array.from({ length: count }, (_, index) =>
      lab(`lab-${String(index).padStart(2, "0")}`, 20 + (index % 3), 20 + Math.floor(index / 3)),
    );
    const warm = assignLabCluster({
      labs,
      layoutFingerprint: "layout-v2:alpha",
      limits: LIMITS,
      roomName: "W1N1",
    });
    const reset = assignLabCluster({
      labs: JSON.parse(JSON.stringify([...labs].reverse())) as OwnedLabSnapshot[],
      layoutFingerprint: "layout-v2:alpha",
      limits: LIMITS,
      roomName: "W1N1",
    });

    expect(reset).toEqual(warm);
    expect(warm).toMatchObject({ status: "assigned", reason: null, scannedLabs: count });
    expect(warm.assignment?.reagentLabIds).toHaveLength(2);
    expect(warm.assignment?.productLabIds).toHaveLength(Math.min(8, count - 2));
    expect(warm.assignment?.boostLabIds).toEqual(
      warm.assignment?.productLabIds.slice(-Math.min(2, count - 2)),
    );
    const reagentLabs = (warm.assignment?.reagentLabIds ?? []).map((id) =>
      required(labs.find((candidate) => candidate.id === id)),
    );
    for (const outputId of warm.assignment?.productLabIds ?? []) {
      const output = required(labs.find((candidate) => candidate.id === outputId));
      expect(reagentLabs.every((reagent) => labRange(output, reagent) <= 2)).toBe(true);
    }
  });

  it("fails closed for loss, inactivity, invalid geometry, duplicates, and caps", () => {
    const valid = [lab("a", 10, 10), lab("b", 12, 10), lab("c", 11, 12)];
    expect(
      assignLabCluster({
        labs: valid.slice(0, 2),
        layoutFingerprint: "layout",
        limits: LIMITS,
        roomName: "W1N1",
      }),
    ).toMatchObject({ assignment: null, reason: "insufficient-labs" });
    expect(
      assignLabCluster({
        labs: valid.map((item, index) => (index === 2 ? { ...item, active: false } : item)),
        layoutFingerprint: "layout",
        limits: LIMITS,
        roomName: "W1N1",
      }),
    ).toMatchObject({ assignment: null, reason: "inactive-labs" });
    expect(
      assignLabCluster({
        labs: [lab("a", 1, 1), lab("b", 10, 10), lab("c", 20, 20)],
        layoutFingerprint: "layout",
        limits: LIMITS,
        roomName: "W1N1",
      }),
    ).toMatchObject({ assignment: null, reason: "no-adjacent-cluster" });
    expect(
      assignLabCluster({
        labs: [required(valid[0]), required(valid[0]), required(valid[2])],
        layoutFingerprint: "layout",
        limits: LIMITS,
        roomName: "W1N1",
      }),
    ).toMatchObject({ assignment: null, reason: "invalid-input" });
    expect(
      assignLabCluster({
        labs: Array.from({ length: 11 }, (_, index) => lab(`lab-${String(index)}`, 20, 20)),
        layoutFingerprint: "layout",
        limits: LIMITS,
        roomName: "W1N1",
      }),
    ).toMatchObject({ assignment: null, reason: "limit-exceeded" });
  });

  it("changes assignment identity after layout revision or lab loss", () => {
    const labs = [lab("a", 10, 10), lab("b", 12, 10), lab("c", 11, 12), lab("d", 11, 11)];
    const first = assignment(labs, "layout-v1");
    const revised = assignment(labs, "layout-v2");
    const lost = assignment(
      labs.filter(({ id }) => id !== "d"),
      "layout-v1",
    );
    expect(revised.fingerprint).not.toBe(first.fingerprint);
    expect(lost.fingerprint).not.toBe(first.fingerprint);
  });

  it("normalizes symmetric reaction facts and rejects malformed or over-cap catalogs", () => {
    const ready = normalizeReactionCatalog({
      maximumReagentsScanned: 4,
      maximumRecipes: 4,
      reactions: { H: { O: "OH", U: "UH" }, O: { H: "OH" }, U: { H: "UH" } },
      reactionTimes: { OH: 20, UH: 10 },
    });
    expect(ready).toMatchObject({
      status: "ready",
      catalog: {
        recipes: [
          { cooldown: 20, product: "OH", reagents: ["H", "O"] },
          { cooldown: 10, product: "UH", reagents: ["H", "U"] },
        ],
      },
    });
    expect(
      normalizeReactionCatalog({
        maximumReagentsScanned: 4,
        maximumRecipes: 4,
        reactions: { H: { O: "OH" } },
        reactionTimes: {},
      }),
    ).toMatchObject({ catalog: null, reason: "invalid-input" });
    expect(
      normalizeReactionCatalog({
        maximumReagentsScanned: 1,
        maximumRecipes: 4,
        reactions: { H: { O: "OH" }, O: { H: "OH" } },
        reactionTimes: { OH: 20 },
      }),
    ).toMatchObject({ catalog: null, reason: "limit-exceeded" });
  });
});

function assignment(labs: readonly OwnedLabSnapshot[], layoutFingerprint: string) {
  const result = assignLabCluster({ labs, layoutFingerprint, limits: LIMITS, roomName: "W1N1" });
  if (result.assignment === null)
    throw new Error(`expected assignment, got ${String(result.reason)}`);
  return result.assignment;
}

function lab(id: string, x: number, y: number): OwnedLabSnapshot {
  return {
    active: true,
    cooldown: 0,
    energy: 1_000,
    energyCapacity: 2_000,
    hits: 500,
    hitsMax: 500,
    id,
    mineralAmount: 0,
    mineralCapacity: 3_000,
    mineralType: null,
    pos: { roomName: "W1N1", x, y },
    store: {
      capacity: 5_000,
      freeCapacity: 4_000,
      resources: [{ amount: 1_000, resourceType: "energy" }],
      usedCapacity: 1_000,
    },
  };
}

function labRange(left: OwnedLabSnapshot, right: OwnedLabSnapshot): number {
  return Math.max(Math.abs(left.pos.x - right.pos.x), Math.abs(left.pos.y - right.pos.y));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required lab fixture is unavailable");
  return value;
}
