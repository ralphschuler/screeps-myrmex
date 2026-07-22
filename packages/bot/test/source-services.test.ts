import { describe, expect, it } from "vitest";
import { diffOwnedRoomLayout, selectSourceServices, type LayoutPlacement } from "../src/layout";

const roomName = "W1N1";
const pos = (x: number, y: number, sourceId?: string) => ({
  roomName,
  ...(sourceId ? { sourceId } : {}),
  x,
  y,
});
const origin: LayoutPlacement = {
  adoption: "planned",
  layer: "primary",
  minimumRcl: 1,
  pos: pos(25, 25),
  structureType: "spawn",
};
const structure = (
  structureType: string,
  x: number,
  y: number,
  id = `${structureType}-${String(x)}-${String(y)}`,
) => ({
  hits: 1_000,
  hitsMax: 1_000,
  id,
  ownerUsername: null,
  ownership: "unowned" as const,
  pos: pos(x, y),
  structureType,
});
const site = (x: number, y: number) => ({
  id: `site-${String(x)}-${String(y)}`,
  ownerUsername: "me",
  ownership: "owned" as const,
  pos: pos(x, y),
  progress: 0,
  progressTotal: 5_000,
  structureType: "container",
});
function terrain(changes: readonly [number, number, "1" | "2"][] = []) {
  const cells = Array.from({ length: 2_500 }, () => "0");
  for (const [x, y, value] of changes) cells[y * 50 + x] = value;
  return { cells: cells.join(""), revision: "test" };
}
function select(options: Partial<Parameters<typeof selectSourceServices>[0]> = {}) {
  return selectSourceServices({
    constructionSites: [],
    placements: [origin],
    roomName,
    sources: [pos(10, 10, "source-a")],
    structures: [],
    terrain: terrain(),
    ...options,
  });
}

describe("source service selection", () => {
  it("sorts two source IDs and remains byte-identical when observations reorder", () => {
    const sources = [pos(40, 40, "source-b"), pos(10, 10, "source-a")];
    const forward = select({ sources });
    const reverse = select({ sources: [...sources].reverse() });
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    expect(forward.placements.map(({ service }) => service?.sourceId)).toEqual([
      "source-a",
      "source-b",
    ]);
    expect(
      new Set(forward.placements.map(({ pos: value }) => `${String(value.x)},${String(value.y)}`))
        .size,
    ).toBe(2);
  });

  it("accepts a single-access source work tile", () => {
    const walls: [number, number, "1"][] = [];
    for (let y = 9; y <= 11; y += 1)
      for (let x = 9; x <= 11; x += 1)
        if (!(x === 9 && y === 10) && !(x === 10 && y === 10)) walls.push([x, y, "1"]);
    expect(select({ terrain: terrain(walls) }).placements[0]?.pos).toEqual(pos(9, 10));
  });

  it("prefers an exact container, then a matching site, before route and terrain ranking", () => {
    expect(select({ structures: [structure("container", 11, 11)] }).placements[0]).toMatchObject({
      adoption: "exact",
      pos: pos(11, 11),
    });
    expect(select({ constructionSites: [site(11, 11)] }).placements[0]).toMatchObject({
      adoption: "matching-site",
      pos: pos(11, 11),
    });
  });

  it("does not rank an exact container beneath a private foreign rampart as executable", () => {
    const exact = structure("container", 11, 11, "exact-service");
    const privateRampart = {
      ...structure("rampart", 11, 11, "private-rampart"),
      isPublic: false,
      ownerUsername: "Enemy",
      ownership: "foreign" as const,
    };

    expect(select({ structures: [exact, privateRampart] }).placements[0]).not.toMatchObject({
      pos: pos(11, 11),
    });
    expect(
      select({ structures: [exact, { ...privateRampart, isPublic: true }] }).placements[0],
    ).toMatchObject({ adoption: "exact", pos: pos(11, 11) });
    expect(
      select({
        structures: [
          exact,
          { ...privateRampart, ownerUsername: "me", ownership: "owned" as const },
        ],
      }).placements[0],
    ).toMatchObject({ adoption: "exact", pos: pos(11, 11) });
  });

  it("keeps a legal prior service when a better exact alternate appears or the old container vanishes", () => {
    const previous = select({ structures: [structure("container", 9, 9, "old-service")] });
    const input = {
      constructionSites: [],
      placements: [origin],
      priorSourceServices: previous.placements,
      roomName,
      sources: [pos(10, 10, "source-a")],
      structures: [
        structure("container", 9, 9, "old-service"),
        structure("container", 11, 11, "new-service"),
      ],
      terrain: terrain(),
    };

    expect(selectSourceServices(input).placements[0]).toMatchObject({
      adoption: "exact",
      pos: pos(9, 9),
    });
    expect(
      selectSourceServices({
        ...input,
        structures: [structure("container", 11, 11, "new-service")],
      }).placements[0],
    ).toMatchObject({ adoption: "planned", pos: pos(9, 9) });
  });

  it("advances one issuance coordinate only for an authorized exact replacement", () => {
    const previous = select({ structures: [structure("container", 9, 9, "old-service")] });
    const replacementOnly = {
      constructionSites: [],
      placements: [origin],
      priorSourceServices: previous.placements,
      roomName,
      sources: [pos(10, 10, "source-a")],
      structures: [structure("container", 11, 11, "new-service")],
      terrain: terrain(),
    };

    expect(selectSourceServices(replacementOnly).placements[0]).toMatchObject({
      adoption: "planned",
      pos: pos(9, 9),
      service: { kind: "source-container", sourceId: "source-a" },
    });
    const switched = selectSourceServices({
      ...replacementOnly,
      sourceServiceHandoffAuthorized: true,
    });
    expect(switched.placements[0]).toEqual({
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: pos(11, 11),
      service: { issuerSequence: 2, kind: "source-container", sourceId: "source-a" },
      structureType: "container",
    });

    const cloned = JSON.parse(JSON.stringify(replacementOnly)) as typeof replacementOnly;
    const reset = selectSourceServices({
      ...cloned,
      priorSourceServices: JSON.parse(JSON.stringify(switched.placements)) as LayoutPlacement[],
      sourceServiceHandoffAuthorized: true,
      structures: [structure("container", 11, 11, "new-service")],
    });
    expect(JSON.stringify(reset)).toBe(JSON.stringify(switched));
  });

  it("hands an existing service to a strictly better exact container without oscillating", () => {
    const previous = select({ structures: [structure("container", 9, 9, "old-service")] });
    const bothExact = {
      constructionSites: [],
      placements: [origin],
      priorSourceServices: previous.placements,
      roomName,
      sourceServiceHandoffAuthorized: true,
      sources: [pos(10, 10, "source-a")],
      structures: [
        structure("container", 9, 9, "old-service"),
        structure("container", 10, 11, "better-service"),
      ],
      terrain: terrain(),
    };

    const switched = selectSourceServices(bothExact);
    expect(switched.placements[0]).toMatchObject({
      adoption: "exact",
      pos: pos(10, 11),
      service: { issuerSequence: 2, kind: "source-container", sourceId: "source-a" },
    });

    const stable = selectSourceServices({
      ...bothExact,
      priorSourceServices: switched.placements,
      structures: [...bothExact.structures].reverse(),
    });
    expect(stable).toEqual(switched);

    const previousBest = select({
      structures: [structure("container", 10, 11, "better-service")],
    });
    const alreadyBest = selectSourceServices({
      ...bothExact,
      priorSourceServices: previousBest.placements,
    });
    expect(alreadyBest).toEqual(previousBest);

    const exhausted = selectSourceServices({
      ...bothExact,
      priorSourceServices: previous.placements.map((placement) => ({
        ...placement,
        service: {
          issuerSequence: Number.MAX_SAFE_INTEGER,
          kind: "source-container" as const,
          sourceId: "source-a",
        },
      })),
    });
    expect(exhausted.placements[0]?.pos).toEqual(pos(9, 9));

    const matchingSite = select({ constructionSites: [site(9, 9)] });
    expect(
      selectSourceServices({
        ...bothExact,
        constructionSites: [site(9, 9)],
        priorSourceServices: matchingSite.placements,
        structures: [structure("container", 10, 11, "better-service")],
      }).placements[0],
    ).toMatchObject({ adoption: "matching-site", pos: pos(9, 9) });
  });

  it("does not hand one source to another source's persisted exact service", () => {
    const prior = (x: number, y: number, sourceId: string): LayoutPlacement => ({
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: pos(x, y),
      service: { kind: "source-container", sourceId },
      structureType: "container",
    });
    const result = selectSourceServices({
      constructionSites: [],
      placements: [origin],
      priorSourceServices: [prior(9, 9, "source-a"), prior(10, 11, "source-b")],
      roomName,
      sourceServiceHandoffAuthorized: true,
      sources: [pos(10, 10, "source-a"), pos(10, 12, "source-b")],
      structures: [
        structure("container", 9, 9, "source-a-service"),
        structure("container", 10, 11, "source-b-service"),
      ],
      terrain: terrain(),
    });

    expect(result.placements).toMatchObject([
      { pos: pos(9, 9), service: { sourceId: "source-a" } },
      { pos: pos(10, 11), service: { sourceId: "source-b" } },
    ]);
    expect(result.placements.every(({ service }) => service?.issuerSequence === undefined)).toBe(
      true,
    );
  });

  it("ignores ambiguous, conflicting, non-adjacent, or blocked prior service evidence", () => {
    const exactAlternate = structure("container", 11, 11, "new-service");
    const prior = (x: number, y: number, sourceId = "source-a"): LayoutPlacement => ({
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: pos(x, y),
      service: { kind: "source-container", sourceId },
      structureType: "container",
    });
    const base = {
      constructionSites: [],
      placements: [origin],
      roomName,
      sources: [pos(10, 10, "source-a")],
      structures: [exactAlternate],
      terrain: terrain(),
    };

    expect(
      selectSourceServices({ ...base, priorSourceServices: [prior(20, 20)] }).placements[0]?.pos,
    ).toEqual(pos(11, 11));
    expect(
      selectSourceServices({ ...base, priorSourceServices: [prior(9, 9), prior(9, 10)] })
        .placements[0]?.pos,
    ).toEqual(pos(11, 11));
    expect(
      selectSourceServices({
        ...base,
        priorSourceServices: [prior(9, 9)],
        terrain: terrain([[9, 9, "1"]]),
      }).placements[0]?.pos,
    ).toEqual(pos(11, 11));

    const conflict = selectSourceServices({
      ...base,
      priorSourceServices: [prior(10, 11), prior(10, 11, "source-b")],
      sources: [pos(10, 10, "source-a"), pos(10, 12, "source-b")],
      structures: [exactAlternate, structure("container", 11, 13, "source-b-alternate")],
    });
    expect(conflict.placements.map(({ pos: placement }) => placement)).toEqual([
      pos(11, 11),
      pos(11, 13),
    ]);
  });

  it("preserves continuity across nontrivial reorder and JSON reconstruction", () => {
    const prior = (x: number, y: number, sourceId: string): LayoutPlacement => ({
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: pos(x, y),
      service: { kind: "source-container", sourceId },
      structureType: "container",
    });
    const input = {
      constructionSites: [],
      placements: [origin],
      priorSourceServices: [prior(9, 9, "source-a"), prior(29, 9, "source-b")],
      roomName,
      sources: [pos(10, 10, "source-a"), pos(30, 10, "source-b")],
      structures: [
        structure("container", 9, 9, "source-a-prior"),
        structure("container", 11, 11, "source-a-alternate"),
        structure("container", 29, 9, "source-b-prior"),
        structure("container", 31, 11, "source-b-alternate"),
      ],
      terrain: terrain(),
    };
    const stable = selectSourceServices(input);
    const cloned = JSON.parse(JSON.stringify(input)) as typeof input;
    const reset = selectSourceServices({
      ...cloned,
      priorSourceServices: [...cloned.priorSourceServices].reverse(),
      sources: [...cloned.sources].reverse(),
      structures: [...cloned.structures].reverse(),
    });

    expect(stable.placements.map(({ pos: placement }) => placement)).toEqual([
      pos(9, 9),
      pos(29, 9),
    ]);
    expect(JSON.stringify(reset)).toBe(JSON.stringify(stable));
  });

  it("uses bounded shortest route, then plain over swamp, then y,x", () => {
    const storage = { ...origin, pos: pos(10, 20), structureType: "storage" } as const;
    const result = select({ placements: [storage, origin], terrain: terrain([[9, 11, "2"]]) });
    expect(result.placements[0]?.pos).toEqual(pos(10, 11));
  });

  it("does not collide overlapping candidate sets and isolates a source with no legal tile", () => {
    const adjacentSources = [pos(10, 10, "source-a"), pos(11, 11, "source-b")];
    const adjacent = select({ sources: adjacentSources });
    expect(
      adjacent.placements.every(({ pos: placement }) =>
        adjacentSources.every((source) => source.x !== placement.x || source.y !== placement.y),
      ),
    ).toBe(true);

    const sources = [pos(10, 10, "source-a"), pos(10, 12, "source-b")];
    const collision = select({ sources });
    expect(collision.placements).toHaveLength(2);
    expect(
      new Set(collision.placements.map(({ pos: value }) => `${String(value.x)},${String(value.y)}`))
        .size,
    ).toBe(2);

    const walls: [number, number, "1"][] = [];
    for (let y = 39; y <= 41; y += 1)
      for (let x = 39; x <= 41; x += 1) if (!(x === 40 && y === 40)) walls.push([x, y, "1"]);
    const degraded = select({
      sources: [...sources, pos(40, 40, "source-c")],
      terrain: terrain(walls),
    });
    expect(degraded.placements).toHaveLength(2);
    expect(degraded.blockers).toEqual([
      {
        kind: "source-container",
        pos: pos(40, 40),
        reason: "no-legal-position",
        sourceId: "source-c",
      },
    ]);
  });

  it("lets a matching site suppress the semantic placement in the existing layout diff", () => {
    const matching = site(9, 9);
    const selected = select({ constructionSites: [matching] });
    const commitment = {
      algorithmRevision: "owned-room-layout-v2-source-services",
      anchor: origin.pos,
      blockers: [],
      committedAt: 1,
      fingerprint: "layout-v2:test",
      transform: 0,
    } as const;
    const policy = {
      version: 1,
      level: 2,
      spawnPoolCapacityTarget: 300,
      unlocks: {
        containers: 5,
        extensions: 5,
        extractor: 0,
        factory: 0,
        labs: 0,
        links: 0,
        nuker: 0,
        observer: 0,
        powerSpawn: 0,
        ramparts: true,
        spawns: 1,
        storage: 0,
        terminal: 0,
        towers: 0,
        walls: true,
      },
      protectedSpawnReserve: { target: 300, available: 300, state: "restored" },
      domains: [],
      progression: { status: "authorized", authorized: true, reasonCode: "active" },
    } as const;
    const diff = diffOwnedRoomLayout({
      colonyId: roomName,
      commitment,
      commitmentConflicted: false,
      constructionSites: [matching],
      observationFingerprint: "obs",
      placements: selected.placements,
      policy,
      policyEnabled: true,
      policyFingerprint: "policy",
      roomName,
      roomStatus: "owned",
      structures: [],
    });
    expect(diff.proposals).toEqual([]);
    expect(diff.suppressed).toHaveLength(1);
    expect(JSON.stringify(selected)).not.toMatch(/contract|command|role|harvest/u);
  });
});
