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
  persistLayoutLabEvacuation,
  persistLayoutLinkEvacuation,
  persistLayoutTowerEvacuation,
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
    expect(owner.schemaVersion).toBe(24);
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
      schemaVersion: 24,
      revision: owner.revision + 1,
    });
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 3 })).toBeNull();
  });

  it("migrates V14 without inventing spawn removal evidence and rejects spoofed receipts", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 14 })).toEqual({
      ...owner,
      revision: owner.revision + 1,
      schemaVersion: 24,
    });
    const receipt = {
      attempt: 1,
      code: "ERR_BUSY",
      nextEligibleTick: 13,
      observedAt: 11,
      replacementId: "spawn-exact",
      targetId: "spawn-obsolete",
      targetStructureType: "spawn",
    } as const;
    const records = [{ ...owner.records[0], removalReceipt: receipt }];
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 14, records })).toBeNull();
    expect(parseLayoutsOwner({ ...owner, records })).toEqual({ ...owner, records });
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

  it("migrates V6 through V7 and persists one bounded tower evacuation in V8", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    const legacy = { ...owner, schemaVersion: 6 };
    expect(parseLayoutsOwner(legacy)).toEqual({
      ...owner,
      revision: owner.revision + 1,
    });

    const evacuation = {
      amount: 500,
      expiresAt: 160,
      replacementId: "tower-replacement",
      replacementInitialEnergy: 10,
      sourceId: "tower-obsolete",
      startedAt: 10,
    } as const;
    owner = persistLayoutTowerEvacuation(owner, "W1N1", evacuation);

    expect(owner.schemaVersion).toBe(24);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 7 })).toEqual({
      ...owner,
      revision: owner.revision + 1,
    });
    expect(persistLayoutCommitment(owner, "W1N1", commitment).records[0]?.towerEvacuation).toEqual(
      evacuation,
    );
    expect(
      persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-v2:b" })
        .records[0]?.towerEvacuation,
    ).toBeUndefined();
    expect(
      persistLayoutTowerEvacuation(owner, "W1N1", null).records[0]?.towerEvacuation,
    ).toBeUndefined();
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 6 })).toBeNull();

    for (const invalid of [
      { ...evacuation, amount: 0 },
      { ...evacuation, amount: 1_000 },
      { ...evacuation, expiresAt: 159 },
      { ...evacuation, replacementId: evacuation.sourceId },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], towerEvacuation: invalid }],
        }),
      ).toBeNull();
  });

  it("migrates V8 and persists one bounded reserve-link evacuation in V9", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    const legacy = { ...owner, schemaVersion: 8 };
    expect(parseLayoutsOwner(legacy)).toEqual({
      ...owner,
      revision: owner.revision + 1,
    });

    const evacuation = {
      amount: 300,
      expiresAt: 160,
      replacementId: "link-reserve-exact",
      replacementInitialEnergy: 0,
      sourceId: "link-reserve-external",
      startedAt: 10,
    } as const;
    owner = persistLayoutLinkEvacuation(owner, "W1N1", evacuation);

    expect(owner.schemaVersion).toBe(24);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(persistLayoutCommitment(owner, "W1N1", commitment).records[0]?.linkEvacuation).toEqual(
      evacuation,
    );
    expect(
      persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-v2:b" })
        .records[0]?.linkEvacuation,
    ).toBeUndefined();
    expect(
      persistLayoutLinkEvacuation(owner, "W1N1", null).records[0]?.linkEvacuation,
    ).toBeUndefined();
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 8 })).toBeNull();

    for (const invalid of [
      { ...evacuation, amount: 0 },
      { ...evacuation, amount: 801 },
      { ...evacuation, expiresAt: 159 },
      { ...evacuation, replacementId: evacuation.sourceId },
      { ...evacuation, replacementInitialEnergy: -1 },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], linkEvacuation: invalid }],
        }),
      ).toBeNull();
  });

  it("migrates V10 without inventing lab evacuation and preserves bounded energy terms", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    expect(owner.schemaVersion).toBe(24);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 10 })).toEqual({
      ...owner,
      revision: owner.revision + 1,
    });

    const evacuation = {
      amount: 750,
      expiresAt: 160,
      replacementId: "lab-replacement",
      replacementInitialEnergy: 250,
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    owner = persistLayoutLabEvacuation(owner, "W1N1", evacuation);

    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(persistLayoutCommitment(owner, "W1N1", commitment).records[0]?.labEvacuation).toEqual(
      evacuation,
    );
    expect(
      persistLayoutCommitment(owner, "W1N1", { ...commitment, fingerprint: "layout-v2:b" })
        .records[0]?.labEvacuation,
    ).toBeUndefined();
    expect(
      persistLayoutLabEvacuation(owner, "W1N1", null).records[0]?.labEvacuation,
    ).toBeUndefined();
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 10 })).toBeNull();

    for (const invalid of [
      { ...evacuation, amount: 0 },
      { ...evacuation, amount: 2_001 },
      { ...evacuation, expiresAt: 159 },
      { ...evacuation, replacementId: evacuation.sourceId },
      { ...evacuation, replacementInitialEnergy: 1_251 },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], labEvacuation: invalid }],
        }),
      ).toBeNull();
  });

  it("migrates V11 energy terms and persists one bounded V12 mineral evacuation", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    expect(owner.schemaVersion).toBe(24);
    const energy = {
      amount: 750,
      expiresAt: 160,
      replacementId: "lab-replacement",
      replacementInitialEnergy: 250,
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    owner = persistLayoutLabEvacuation(owner, "W1N1", energy);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 11 })).toEqual({
      ...owner,
      revision: owner.revision + 1,
    });

    const mineral = {
      amount: 3_000,
      destinationId: "storage",
      destinationInitialAmount: 10_000,
      expiresAt: 160,
      replacementId: "lab-replacement",
      resourceType: "XGH2O",
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    owner = persistLayoutLabEvacuation(owner, "W1N1", mineral);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 11 })).toBeNull();

    for (const invalid of [
      { ...mineral, amount: 3_001 },
      { ...mineral, destinationId: mineral.sourceId },
      { ...mineral, destinationInitialAmount: -1 },
      { ...mineral, destinationInitialAmount: 997_001 },
      { ...mineral, expiresAt: 159 },
      { ...mineral, resourceType: "energy" },
      { ...mineral, resourceType: " XGH2O" },
      { ...mineral, replacementInitialEnergy: 0 },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], labEvacuation: invalid }],
        }),
      ).toBeNull();
  });

  it("migrates V12 without inventing mixed lab terms and persists one bounded V13 pair", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 12 })).toEqual({
      ...owner,
      revision: owner.revision + 1,
      schemaVersion: 24,
    });

    const mixed = {
      destinationId: "storage",
      destinationInitialAmount: 10_000,
      energyAmount: 750,
      expiresAt: 160,
      mineralAmount: 3_000,
      replacementId: "lab-replacement",
      replacementInitialEnergy: 250,
      resourceType: "XGH2O",
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    owner = persistLayoutLabEvacuation(owner, "W1N1", mixed);
    expect(owner.schemaVersion).toBe(24);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 12 })).toBeNull();

    for (const invalid of [
      { ...mixed, energyAmount: 0 },
      { ...mixed, energyAmount: 2_001 },
      { ...mixed, mineralAmount: 0 },
      { ...mixed, mineralAmount: 3_001 },
      { ...mixed, replacementInitialEnergy: 1_251 },
      { ...mixed, destinationInitialAmount: 997_001 },
      { ...mixed, resourceType: "energy" },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], labEvacuation: invalid }],
        }),
      ).toBeNull();
  });

  it("migrates V13 without inventing terminal semantics and persists one bounded V14 terminal destination", () => {
    let owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 13 })).toEqual({
      ...owner,
      revision: owner.revision + 1,
      schemaVersion: 24,
    });

    const terminal = {
      amount: 3_000,
      destinationId: "terminal",
      destinationInitialAmount: 297_000,
      destinationStructureType: "terminal",
      expiresAt: 160,
      replacementId: "lab-replacement",
      resourceType: "XGH2O",
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    owner = persistLayoutLabEvacuation(owner, "W1N1", terminal);

    expect(owner.schemaVersion).toBe(24);
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 13 })).toBeNull();

    const mixedTerminal = {
      destinationId: "terminal",
      destinationInitialAmount: 296_500,
      destinationStructureType: "terminal",
      energyAmount: 500,
      expiresAt: 160,
      mineralAmount: 3_000,
      replacementId: "lab-replacement",
      replacementInitialEnergy: 250,
      resourceType: "XGH2O",
      sourceId: "lab-obsolete",
      startedAt: 10,
    } as const;
    const mixedOwner = {
      ...owner,
      records: [{ ...owner.records[0], labEvacuation: mixedTerminal }],
    };
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(mixedOwner)))).toEqual(mixedOwner);

    for (const invalid of [
      { ...terminal, destinationInitialAmount: 297_001 },
      { ...terminal, destinationStructureType: "storage" },
      { ...mixedTerminal, destinationInitialAmount: 297_001 },
      { ...mixedTerminal, destinationStructureType: "storage" },
    ])
      expect(
        parseLayoutsOwner({
          ...owner,
          records: [{ ...owner.records[0], labEvacuation: invalid }],
        }),
      ).toBeNull();
  });

  it("migrates V9 without inventing lab receipts and rejects spoofed legacy evidence", () => {
    const owner = persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment);
    expect(owner.schemaVersion).toBe(24);
    expect(parseLayoutsOwner({ ...owner, schemaVersion: 9 })).toEqual({
      ...owner,
      revision: owner.revision + 1,
    });

    const intent: DestroyOwnedStructureIntent = {
      colonyId: "W1N1",
      kind: "destroy-owned-structure",
      layoutFingerprint: commitment.fingerprint,
      observationFingerprint: "observation-a",
      policyFingerprint: "policy-a",
      replacementId: "lab-replacement",
      replacementStructureType: "lab",
      roomName: "W1N1",
      stableId: "remove-lab/lab-obsolete",
      targetId: "lab-obsolete",
      targetRequiresEmptyStore: true,
      targetRequiresZeroCooldown: true,
      targetStructureType: "lab",
      x: 10,
      y: 11,
    };
    const reconciled = reconcileStructureDestroyExecution(
      owner,
      [{ called: true, code: "OK", fault: null, intent }],
      20,
    ).owner;
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(reconciled)))).toEqual(reconciled);
    expect(parseLayoutsOwner({ ...reconciled, schemaVersion: 9 })).toBeNull();
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
      schemaVersion: 24,
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
    expect(parseLayoutsOwner({ ...extension.owner, schemaVersion: 5 })).toEqual({
      ...extension.owner,
      revision: extension.owner.revision + 1,
    });

    const spawnIntent = {
      ...intent,
      replacementId: "spawn-exact",
      replacementRequiresIdle: true,
      replacementStructureType: "spawn",
      stableId: "remove-spawn-v1:test",
      targetId: "spawn-obsolete",
      targetRequiresIdle: true,
      targetStructureType: "spawn",
    } as const satisfies DestroyOwnedStructureIntent;
    const spawn = reconcileStructureDestroyExecution(
      persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment),
      [{ called: true, code: "ERR_BUSY", fault: null, intent: spawnIntent }],
      11,
    );
    expect(spawn.owner.records[0]?.removalReceipt).toMatchObject({
      replacementId: "spawn-exact",
      targetId: "spawn-obsolete",
      targetStructureType: "spawn",
    });
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(spawn.owner)))).toEqual(spawn.owner);
    expect(parseLayoutsOwner({ ...spawn.owner, schemaVersion: 14 })).toBeNull();

    const towerIntent = {
      ...intent,
      replacementId: "tower-replacement",
      replacementStructureType: "tower",
      stableId: "remove-tower-v1:test",
      targetId: "tower-obsolete",
      targetStructureType: "tower",
    } as const satisfies DestroyOwnedStructureIntent;
    const tower = reconcileStructureDestroyExecution(
      persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment),
      [{ called: true, code: "ERR_BUSY", fault: null, intent: towerIntent }],
      11,
    );
    expect(tower.owner.records[0]?.removalReceipt).toMatchObject({
      replacementId: "tower-replacement",
      targetId: "tower-obsolete",
      targetStructureType: "tower",
    });
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(tower.owner)))).toEqual(tower.owner);
    expect(parseLayoutsOwner({ ...tower.owner, schemaVersion: 6 })).toEqual({
      ...tower.owner,
      revision: tower.owner.revision + 1,
    });
    expect(parseLayoutsOwner({ ...tower.owner, schemaVersion: 5 })).toBeNull();

    const linkIntent = {
      ...intent,
      replacementExpectedEnergy: 0,
      replacementId: "link-reserve-exact",
      replacementRequiresZeroCooldown: true,
      replacementStructureType: "link",
      stableId: "remove-reserve-link-v1:test",
      targetId: "link-reserve-external",
      targetRequiresZeroCooldown: true,
      targetStructureType: "link",
    } as const satisfies DestroyOwnedStructureIntent;
    const link = reconcileStructureDestroyExecution(
      persistLayoutCommitment(emptyLayoutsOwner(), "W1N1", commitment),
      [{ called: true, code: "ERR_BUSY", fault: null, intent: linkIntent }],
      11,
    );
    expect(link.owner.records[0]?.removalReceipt).toMatchObject({
      replacementId: "link-reserve-exact",
      targetId: "link-reserve-external",
      targetStructureType: "link",
    });
    expect(parseLayoutsOwner(JSON.parse(JSON.stringify(link.owner)))).toEqual(link.owner);
    expect(parseLayoutsOwner({ ...link.owner, schemaVersion: 7 })).toBeNull();
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
