import { describe, expect, it } from "vitest";
import { projectColonyRclPolicy } from "../src/colony";
import { diffOwnedRoomLayout, type LayoutDiffInput, type LayoutPlacement } from "../src/layout";

const pos = (x: number, y: number) => ({ roomName: "W1N1", x, y });
const placement = (
  structureType: string,
  x: number,
  y: number,
  minimumRcl = 2,
): LayoutPlacement => ({
  adoption: "planned",
  layer: structureType === "road" ? "road" : "primary",
  minimumRcl,
  pos: pos(x, y),
  structureType,
});
const policy = projectColonyRclPolicy({
  activeThreat: false,
  controllerLevel: 3,
  controllerRisk: false,
  cpuMode: "normal",
  energyAvailable: 800,
  energyCapacityAvailable: 800,
  protectedSpawnEnergy: 300,
  state: "developing",
  visibility: "visible",
});
function input(overrides: Partial<LayoutDiffInput> = {}): LayoutDiffInput {
  return {
    colonyId: "colony-a",
    commitment: {
      algorithmRevision: "owned-room-layout-v1",
      anchor: pos(25, 25),
      blockers: [],
      committedAt: 1,
      fingerprint: "layout-a",
      transform: 0,
    },
    commitmentConflicted: false,
    constructionSites: [],
    observationFingerprint: "obs-a",
    placements: [placement("extension", 20, 20), placement("road", 21, 20)],
    policy,
    policyEnabled: true,
    policyFingerprint: "policy-a",
    roomName: "W1N1",
    roomStatus: "owned",
    structures: [],
    ...overrides,
  };
}
const structure = (type: string, x: number, y: number) => ({
  hits: 1,
  hitsMax: 1,
  id: `${type}-${String(x)}-${String(y)}`,
  ownerUsername: "me",
  ownership: "owned" as const,
  pos: pos(x, y),
  structureType: type,
});
const site = (type: string, x: number, y: number, ownership: "owned" | "foreign" = "owned") => ({
  id: `site-${type}-${String(x)}-${String(y)}`,
  ownerUsername: ownership === "owned" ? "me" : "them",
  ownership,
  pos: pos(x, y),
  progress: 0,
  progressTotal: 100,
  structureType: type,
});

describe("layout diff", () => {
  it("suppresses adopted structures and matching owned sites without dismantling", () => {
    const result = diffOwnedRoomLayout(
      input({
        placements: [
          { ...placement("extension", 20, 20), adoption: "compatible-external" },
          placement("road", 21, 20),
          placement("tower", 22, 20),
        ],
        structures: [structure("extension", 20, 20)],
        constructionSites: [site("road", 21, 20)],
      }),
    );
    expect(result.suppressed.map((item) => item.reason)).toEqual([
      "existing-structure",
      "existing-owned-site",
    ]);
    expect(result.proposals.map((item) => item.structureType)).toEqual(["tower"]);
    expect(JSON.stringify(result)).not.toContain("dismantle");
  });
  it.each([
    ["unknown", "room-unknown"],
    ["lost", "room-lost"],
  ] as const)("fails closed for %s observation", (roomStatus, reason) => {
    expect(
      diffOwnedRoomLayout(input({ roomStatus })).rejected.every((item) => item.reason === reason),
    ).toBe(true);
  });
  it("fails closed for policy, commitment, occupancy, foreign site, RCL, and allowance", () => {
    expect(diffOwnedRoomLayout(input({ policyEnabled: false })).rejected[0]?.reason).toBe(
      "policy-disabled",
    );
    expect(diffOwnedRoomLayout(input({ commitmentConflicted: true })).rejected[0]?.reason).toBe(
      "commitment-conflict",
    );
    expect(
      diffOwnedRoomLayout(input({ structures: [structure("tower", 20, 20)] })).rejected[0]?.reason,
    ).toBe("different-structure");
    expect(
      diffOwnedRoomLayout(input({ constructionSites: [site("extension", 20, 20, "foreign")] }))
        .rejected[0]?.reason,
    ).toBe("foreign-site");
    expect(
      diffOwnedRoomLayout(input({ placements: [placement("tower", 20, 20, 4)] })).rejected[0]
        ?.reason,
    ).toBe("rcl-locked");
    expect(
      diffOwnedRoomLayout(
        input({
          placements: [placement("spawn", 20, 20)],
          structures: [structure("spawn", 10, 10)],
        }),
      ).rejected[0]?.reason,
    ).toBe("over-allowance");
  });
  it("is byte-identical under reordered facts and invalidates IDs on layout revision", () => {
    const placements = [
      placement("road", 8, 9),
      placement("tower", 7, 9),
      placement("extension", 6, 9),
    ];
    const a = diffOwnedRoomLayout(
      input({ placements, structures: [structure("spawn", 1, 1), structure("extension", 2, 2)] }),
    );
    const b = diffOwnedRoomLayout(
      input({
        placements: [...placements].reverse(),
        structures: [structure("extension", 2, 2), structure("spawn", 1, 1)],
      }),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const revised = diffOwnedRoomLayout(
      input({ placements, commitment: { ...input().commitment, fingerprint: "layout-b" } }),
    );
    expect(revised.proposals[0]?.stableId).not.toBe(a.proposals[0]?.stableId);
  });
});
