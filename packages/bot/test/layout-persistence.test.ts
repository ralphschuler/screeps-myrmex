import { describe, expect, it } from "vitest";
import { CacheManager } from "../src/cache";
import {
  emptyLayoutsOwner,
  layoutCacheDependencies,
  layoutContainerMigrationResourceFlowId,
  parseLayoutsOwner,
  persistConstructionSiteReceipt,
  persistLayoutCommitment,
  persistLayoutContainerMigration,
  persistLayoutExtensionEvacuation,
  reconcileOwnedLayouts,
  reconcileStructureDestroyExecution,
  registerLayoutCompiledCache,
  type DestroyOwnedStructureIntent,
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

  it("persists bounded source-service issuance and migrates legacy owners without inventing it", () => {
    const placement = {
      adoption: "exact",
      layer: "primary",
      minimumRcl: 2,
      pos: { roomName: "W1N1", x: 11, y: 11 },
      service: { issuerSequence: 2, kind: "source-container", sourceId: "source-a" },
      structureType: "container",
    } as const;
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment, [placement]);
    expect(owner.schemaVersion).toBe(5);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);

    const { issuerSequence: _sequence, ...legacyService } = placement.service;
    void _sequence;
    const legacy = {
      ...owner,
      schemaVersion: 3,
      records: [
        {
          ...owner.records[0],
          sourceServices: [{ ...placement, service: legacyService }],
        },
      ],
    };
    expect(parseLayoutsOwner(legacy)).toEqual({
      ...legacy,
      schemaVersion: 5,
      revision: owner.revision + 1,
    });
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 3 })).toBeNull();
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

  it("persists one bounded general-container migration and drops it on layout revision", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    const migration = {
      energyAmount: 50,
      expiresAt: 160,
      replacementId: "container-replacement",
      replacementInitialEnergy: 0,
      startedAt: 10,
      targetId: "container-obsolete",
    } as const;
    owner = persistLayoutContainerMigration(owner, "W1N1", migration);

    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    for (const schemaVersion of [1, 2])
      expect(parseLayoutsOwner({ ...owner, schemaVersion })).toEqual({
        ...owner,
        revision: owner.revision + 1,
      });
    expect(
      persistLayoutCommitment(owner, "W1N1", commitment).records[0]?.containerMigration,
    ).toEqual(migration);
    expect(
      persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-v2:b" })
        .records[0]?.containerMigration,
    ).toBeUndefined();
    expect(
      persistLayoutContainerMigration(owner, "W1N1", null).records[0]?.containerMigration,
    ).toBeUndefined();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [
          {
            ...owner.records[0],
            containerMigration: { ...migration, expiresAt: 159 },
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [
          {
            ...owner.records[0],
            containerMigration: { ...migration, replacementInitialEnergy: undefined },
          },
        ],
      }),
    ).toBeNull();
    const {
      energyAmount: _energyAmount,
      replacementInitialEnergy: _baseline,
      ...legacy
    } = migration;
    void _energyAmount;
    void _baseline;
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [{ ...owner.records[0], containerMigration: legacy }],
      })?.records[0]?.containerMigration,
    ).toEqual(legacy);

    const mixed = {
      expiresAt: 160,
      replacementId: "container-replacement",
      resourceManifest: [
        ["U", 25, 5],
        ["energy", 25, 10],
      ],
      startedAt: 10,
      targetId: "container-obsolete",
    } as const;
    owner = persistLayoutContainerMigration(owner, "W1N1", mixed);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 1 })).toBeNull();

    const singletonNonEnergy = {
      ...mixed,
      resourceManifest: [["U", 25, 5]],
    } as const;
    owner = persistLayoutContainerMigration(owner, "W1N1", singletonNonEnergy);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 1 })).toBeNull();
    const sourceMigration = { ...singletonNonEnergy, sourceId: "source-a" } as const;
    owner = persistLayoutContainerMigration(owner, "W1N1", sourceMigration);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 2 })).toBeNull();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [
          {
            ...owner.records[0],
            containerMigration: { ...singletonNonEnergy, resourceManifest: [["energy", 25, 5]] },
          },
        ],
      }),
    ).toBeNull();

    for (const resourceManifest of [
      [...mixed.resourceManifest].reverse(),
      [mixed.resourceManifest[0], mixed.resourceManifest[0]],
      [["U", 25, 5, "unexpected"]],
      Array.from({ length: 9 }, (_, index) => [`r${String(index)}`, 1, 0] as const),
      [
        ["U", 1_500, 0],
        ["energy", 501, 0],
      ],
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [
            {
              ...owner.records[0],
              containerMigration: { ...mixed, resourceManifest },
            },
          ],
        }),
      ).toBeNull();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [
          {
            ...owner.records[0],
            containerMigration: { ...migration, resourceManifest: mixed.resourceManifest },
          },
        ],
      }),
    ).toBeNull();
    expect(
      layoutContainerMigrationResourceFlowId(
        "W1N1",
        {
          replacementId: "r".repeat(24),
          targetId: "t".repeat(24),
        },
        "resource".repeat(8),
      ),
    ).toBeNull();
  });

  it("persists identity-bound destroy backoff for every current removal path", () => {
    const sourceMigration = {
      energyAmount: 50,
      expiresAt: 160,
      replacementId: "container-replacement",
      replacementInitialEnergy: 0,
      sourceId: "source-a",
      startedAt: 10,
      targetId: "container-obsolete",
    } as const;
    let owner = persistLayoutContainerMigration(
      persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment),
      "W1N1",
      sourceMigration,
    );
    const legacyReceipt = {
      attempt: 1,
      code: "ERR_BUSY",
      nextEligibleTick: 13,
      observedAt: 11,
    } as const;
    const legacyRecord = owner.records[0];
    if (legacyRecord?.containerMigration === undefined)
      throw new Error("expected source migration record");
    const migrated = parseLayoutsOwner({
      ...owner,
      schemaVersion: 4,
      records: [
        {
          ...legacyRecord,
          containerMigration: {
            ...legacyRecord.containerMigration,
            removalReceipt: legacyReceipt,
          },
        },
      ],
    });
    expect(migrated).toMatchObject({
      revision: owner.revision + 1,
      schemaVersion: 5,
      records: [
        {
          removalReceipt: {
            ...legacyReceipt,
            replacementId: sourceMigration.replacementId,
            targetId: sourceMigration.targetId,
            targetStructureType: "container",
          },
        },
      ],
    });
    expect(migrated?.records[0]?.containerMigration).not.toHaveProperty("removalReceipt");
    expect(
      parseLayoutsOwner({
        ...owner,
        schemaVersion: 4,
        records: [
          {
            ...legacyRecord,
            removalReceipt: {
              ...legacyReceipt,
              replacementId: sourceMigration.replacementId,
              targetId: sourceMigration.targetId,
              targetStructureType: "container",
            },
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseLayoutsOwner({
        ...owner,
        records: [
          {
            ...legacyRecord,
            removalReceipt: {
              ...legacyReceipt,
              replacementId: sourceMigration.replacementId,
              targetId: "",
              targetStructureType: "container",
            },
          },
        ],
      }),
    ).toBeNull();
    const intent = {
      colonyId: "W1N1",
      kind: "destroy-owned-structure",
      layoutFingerprint: commitment.fingerprint,
      observationFingerprint: "observation-a",
      policyFingerprint: "policy-a",
      replacementId: sourceMigration.replacementId,
      replacementStructureType: "container",
      roomName: "W1N1",
      stableId: "remove-source-container-v1:test",
      targetId: sourceMigration.targetId,
      targetRequiresEmptyStore: true,
      targetStructureType: "container",
      x: 10,
      y: 11,
    } as const satisfies DestroyOwnedStructureIntent;
    const failure = { called: true, code: "ERR_BUSY", fault: null, intent } as const;
    const first = reconcileStructureDestroyExecution(owner, [failure], 11);
    expect(first.receipts).toEqual([
      {
        attempt: 1,
        code: "ERR_BUSY",
        nextEligibleTick: 13,
        observedAt: 11,
        replacementId: "container-replacement",
        targetId: "container-obsolete",
        targetStructureType: "container",
      },
    ]);
    expect(reconcileStructureDestroyExecution(first.owner, [failure], 11).owner).toBe(first.owner);
    const second = reconcileStructureDestroyExecution(first.owner, [failure], 13);
    const third = reconcileStructureDestroyExecution(second.owner, [failure], 17);
    expect(third.owner.records[0]?.removalReceipt).toEqual({
      attempt: 3,
      code: "ERR_BUSY",
      nextEligibleTick: Number.MAX_SAFE_INTEGER,
      observedAt: 17,
      replacementId: "container-replacement",
      targetId: "container-obsolete",
      targetStructureType: "container",
    });
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(third.owner)))).toEqual(third.owner);

    const { sourceId: _sourceId, ...generalMigration } = sourceMigration;
    void _sourceId;
    owner = persistLayoutContainerMigration(
      persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment),
      "W1N1",
      generalMigration,
    );
    const general = reconcileStructureDestroyExecution(owner, [failure], 11);
    expect(general.receipts).toHaveLength(1);
    expect(general.owner.records[0]?.removalReceipt).toMatchObject({
      targetId: "container-obsolete",
      targetStructureType: "container",
    });

    const extensionIntent = {
      ...intent,
      replacementId: "extension-replacement",
      replacementStructureType: "extension",
      stableId: "remove-extension-v1:test",
      targetId: "extension-obsolete",
      targetStructureType: "extension",
    } as const satisfies DestroyOwnedStructureIntent;
    const extension = reconcileStructureDestroyExecution(
      persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment),
      [{ called: true, code: "UNEXPECTED", fault: "adapter-fault", intent: extensionIntent }],
      11,
    );
    expect(extension.owner.records[0]?.removalReceipt).toMatchObject({
      replacementId: "extension-replacement",
      targetId: "extension-obsolete",
      targetStructureType: "extension",
    });
    expect(
      persistLayoutCommitment(extension.owner, "W1N1", commitment).records[0]?.removalReceipt,
    ).toEqual(extension.owner.records[0]?.removalReceipt);
    expect(
      persistLayoutCommitment(extension.owner, "W1N1", {
        ...commitment,
        fingerprint: "layout-v2:changed",
      }).records[0]?.removalReceipt,
    ).toBeUndefined();
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
