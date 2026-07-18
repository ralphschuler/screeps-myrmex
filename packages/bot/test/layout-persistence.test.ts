import { describe, expect, it } from "vitest";
import { CacheManager } from "../src/cache";
import {
  emptyLayoutsOwner,
  layoutCacheDependencies,
  parseLayoutsOwner,
  persistConstructionSiteReceipt,
  persistLayoutCommitment,
  persistLayoutExtensionEvacuation,
  reconcileOwnedLayouts,
  registerLayoutCompiledCache,
} from "../src/layout";

describe("layout persistence and cache", () => {
  const commitment = {
    algorithmRevision: "owned-room-layout-v2-source-services",
    anchor: { roomName: "W1N1", x: 25, y: 25 },
    blockers: [],
    committedAt: 10,
    fingerprint: "layout-v2:a",
    transform: 0,
  } as const;
  it("persists bounded commitment metadata without placement arrays and drops lost rooms", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(JSON.stringify(owner)).not.toContain("placements");
    expect(reconcileOwnedLayouts(owner, []).records).toEqual([]);
    expect(
      parseLayoutsOwner({ ...owner, records: Array.from({ length: 65 }, () => owner.records[0]) }),
    ).toBeNull();
  });
  it("drops an old algorithm commitment as stale rebuild work instead of rejecting the owner", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    const stale = {
      ...owner,
      records: [{ ...owner.records[0], algorithmRevision: "owned-room-layout-v1" }],
    };
    expect(parseLayoutsOwner(stale)).toMatchObject({ records: [], revision: owner.revision + 1 });
  });
  it("persists one bounded extension evacuation and drops it on layout revision", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    const evacuation = {
      amount: 50,
      expiresAt: 160,
      replacementId: "extension-replacement",
      replacementInitialEnergy: 0,
      sourceId: "extension-obsolete",
      startedAt: 10,
    } as const;
    owner = persistLayoutExtensionEvacuation(owner, "W1N1", evacuation);

    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(
      persistLayoutCommitment(owner, "W1N1", commitment).records[0]?.extensionEvacuation,
    ).toEqual(evacuation);
    expect(
      persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-v2:b" })
        .records[0]?.extensionEvacuation,
    ).toBeUndefined();
    expect(
      persistLayoutExtensionEvacuation(owner, "W1N1", null).records[0]?.extensionEvacuation,
    ).toBeUndefined();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [
          {
            ...owner.records[0],
            extensionEvacuation: { ...evacuation, amount: 0 },
          },
        ],
      }),
    ).toBeNull();
  });

  it("persists 32 canonical receipts and drops them on layout revision", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    for (let index = 0; index < 40; index += 1)
      owner = persistConstructionSiteReceipt(owner, "W1N1", {
        attempt: 1,
        code: "ERR_FULL",
        layoutFingerprint: commitment.fingerprint,
        nextEligibleTick: index + 5,
        observationFingerprint: "obs",
        observedAt: index,
        policyFingerprint: "policy",
        proposalId: `proposal-${String(index)}`,
        roomName: "W1N1",
      });
    expect(owner.records[0]?.siteReceipts).toHaveLength(32);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(
      persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-v1:b" })
        .records[0]?.siteReceipts,
    ).toBeUndefined();
  });
  it("is byte-equivalent with warm/cold layout.compiled.v1 cache and exact dependencies", () => {
    const deps = layoutCacheDependencies({
      algorithmRevision: "owned-room-layout-v2-source-services",
      factsRevision: "f",
      policyRevision: "p",
      terrainRevision: "t",
    });
    const key = { roomName: "W1N1", fingerprint: "a" };
    const build = () =>
      [
        {
          adoption: "planned",
          layer: "road",
          minimumRcl: 2,
          pos: { roomName: "W1N1", x: 1, y: 1 },
          structureType: "road",
        },
      ] as const;
    const cold = registerLayoutCompiledCache(new CacheManager()).getOrCompute(
      key,
      { tick: 1, dependencies: deps },
      build,
    );
    const manager = new CacheManager();
    const cache = registerLayoutCompiledCache(manager);
    cache.getOrCompute(key, { tick: 1, dependencies: deps }, build);
    const warm = cache.getOrCompute(key, { tick: 2, dependencies: deps }, () => []);
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
    expect(manager.registeredNamespaceIds()).toEqual(["layout.compiled.v1"]);
  });
});
