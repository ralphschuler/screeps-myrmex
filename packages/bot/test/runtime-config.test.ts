import { describe, expect, it, vi } from "vitest";
import { RuntimeConfigAuthority, type RuntimeConfigOwnerV1 } from "../src/config/authority";
import {
  FEATURE_GATE_IDS,
  classifyPlayerRelation,
  isFeatureEnabled,
  type FeatureGateId,
} from "../src/config";
import {
  resolveFeatureGates,
  SOURCE_FEATURE_GATES,
  type FeatureGateDefinition,
} from "../src/config/gates";
import { buildRuntimeConfig } from "../src/config/runtime-config";
import {
  MAX_CONFIG_OVERRIDE_ARRAY_ITEMS,
  MAX_CONFIG_OVERRIDE_UTF8_BYTES,
  validateRuntimeOverrides,
} from "../src/config/validation";

describe("RuntimeConfigAuthority", () => {
  it("distinguishes unavailable state from the exact owner initializer", () => {
    const authority = new RuntimeConfigAuthority();
    const unavailable = authority.resolve(null, 10);
    const initialized = authority.resolve({}, 10);

    expect(unavailable.metadata).toEqual({
      status: "owner-unavailable",
      reasonCode: "owner-unavailable",
      candidateRevision: null,
      acceptedCandidateRevision: null,
    });
    expect(unavailable.replacementOwner).toBeNull();
    expect(initialized.metadata.reasonCode).toBe("owner-initialized");
    expect(initialized.replacementOwner).toEqual({
      schemaVersion: 1,
      candidate: null,
      lastValid: null,
    });
    expect(initialized.config).toBe(unavailable.config);
  });

  it("resolves byte-equivalent frozen config and revisions across order and heap reset", () => {
    const firstOwner = owner(7, {
      policy: {
        movement: { maximumPathCost: 250 },
        recovery: { protectedSpawnEnergy: 400, emergencyWorkerEnergyBudget: 350 },
      },
      relations: { allies: ["Zulu", "Alpha"], self: ["Myrmex"] },
      features: { disabled: ["phase1.growth", "phase1.economy"] },
    });
    const reorderedOwner = owner(7, {
      features: { disabled: ["phase1.economy", "phase1.growth"] },
      relations: { self: ["Myrmex"], allies: ["Alpha", "Zulu"] },
      policy: {
        recovery: { emergencyWorkerEnergyBudget: 350, protectedSpawnEnergy: 400 },
        movement: { maximumPathCost: 250 },
      },
    });

    const first = new RuntimeConfigAuthority().resolve(firstOwner, 20);
    const reordered = new RuntimeConfigAuthority().resolve(reorderedOwner, 20);
    expect(JSON.stringify(first.config)).toBe(JSON.stringify(reordered.config));
    expect(first.config.revision).toBe(reordered.config.revision);
    expect(first.config.policyRevision).toBe(reordered.config.policyRevision);
    expect(first.replacementOwner?.lastValid?.overrides).toEqual(
      reordered.replacementOwner?.lastValid?.overrides,
    );
    expect(first.config.relations.allies).toEqual(["Alpha", "Zulu"]);
    assertDeeplyFrozen(first.config);

    const persisted = jsonClone(first.replacementOwner);
    const reset = new RuntimeConfigAuthority().resolve(persisted, 21);
    expect(JSON.stringify(reset.config)).toBe(JSON.stringify(first.config));
    expect(reset.metadata).toMatchObject({
      status: "candidate-accepted",
      reasonCode: "candidate-valid",
    });
    expect(reset.replacementOwner).toBeNull();
  });

  it("detaches input and restages an accepted last-valid until the caller persists it", () => {
    const overrides = { policy: { recovery: { protectedSpawnEnergy: 450 } } };
    const input = owner(1, overrides);
    const authority = new RuntimeConfigAuthority();
    const first = authority.resolve(input, 1);

    overrides.policy.recovery.protectedSpawnEnergy = 700;
    expect(first.config.policy.recovery.protectedSpawnEnergy).toBe(450);
    expect(() => {
      (first.config.policy.recovery as { protectedSpawnEnergy: number }).protectedSpawnEnergy = 1;
    }).toThrow(TypeError);

    const unchangedInput = owner(2, {
      policy: { recovery: { protectedSpawnEnergy: 500 } },
    });
    const restagingAuthority = new RuntimeConfigAuthority();
    const staged = restagingAuthority.resolve(unchangedInput, 2);
    const repeated = restagingAuthority.resolve(jsonClone(unchangedInput), 3);
    expect(repeated.config).toBe(staged.config);
    expect(repeated.replacementOwner).toEqual(staged.replacementOwner);

    const committed = restagingAuthority.resolve(jsonClone(staged.replacementOwner), 4);
    expect(committed.replacementOwner).toBeNull();
  });

  it("trusts an unchanged candidate revision only within the current heap", () => {
    const authority = new RuntimeConfigAuthority();
    const accepted = authority.resolve(
      owner(3, { policy: { recovery: { protectedSpawnEnergy: 450 } } }),
      1,
    );
    const changedWithoutRevision = owner(
      3,
      { policy: { recovery: { protectedSpawnEnergy: 700 } } },
      accepted.replacementOwner?.lastValid ?? null,
    );

    expect(
      authority.resolve(changedWithoutRevision, 2).config.policy.recovery.protectedSpawnEnergy,
    ).toBe(450);
    const reset = new RuntimeConfigAuthority().resolve(changedWithoutRevision, 2);
    expect(reset.metadata.reasonCode).toBe("candidate-revision-reused");
    expect(reset.config.policy.recovery.protectedSpawnEnergy).toBe(450);
  });

  it("invalidates revision caches when the durable owner becomes unavailable", () => {
    const authority = new RuntimeConfigAuthority();
    expect(
      authority.resolve(owner(3, { policy: { recovery: { protectedSpawnEnergy: 450 } } }), 1).config
        .policy.recovery.protectedSpawnEnergy,
    ).toBe(450);

    authority.resolve(null, 2);
    expect(
      authority.resolve(owner(3, { policy: { recovery: { protectedSpawnEnergy: 700 } } }), 3).config
        .policy.recovery.protectedSpawnEnergy,
    ).toBe(700);
  });

  it("treats a null candidate as no proposal and preserves the monotonic receipt across reset", () => {
    const accepted = new RuntimeConfigAuthority().resolve(
      owner(5, { policy: { recovery: { protectedSpawnEnergy: 500 } } }),
      1,
    );
    const persisted = jsonClone(accepted.replacementOwner);
    if (persisted === null || persisted.lastValid === null) {
      throw new Error("expected accepted config owner");
    }
    const noProposal = { ...persisted, candidate: null };
    const ownerBytes = JSON.stringify(noProposal);

    const warm = new RuntimeConfigAuthority().resolve(noProposal, 2);
    const reset = new RuntimeConfigAuthority().resolve(jsonClone(noProposal), 2);

    for (const resolution of [warm, reset]) {
      expect(resolution.metadata).toEqual({
        status: "last-valid-retained",
        reasonCode: "no-candidate",
        candidateRevision: null,
        acceptedCandidateRevision: 5,
      });
      expect(resolution.config.policy.recovery.protectedSpawnEnergy).toBe(500);
      expect(resolution.replacementOwner).toBeNull();
    }
    expect(JSON.stringify(warm.config)).toBe(JSON.stringify(reset.config));
    expect(JSON.stringify(noProposal)).toBe(ownerBytes);

    const stale = new RuntimeConfigAuthority().resolve(
      {
        ...noProposal,
        candidate: {
          revision: 4,
          overrides: { policy: { recovery: { protectedSpawnEnergy: 700 } } },
        },
      },
      3,
    );
    expect(stale.metadata).toMatchObject({
      status: "last-valid-retained",
      reasonCode: "candidate-stale",
      acceptedCandidateRevision: 5,
    });
    expect(stale.config.policy.recovery.protectedSpawnEnergy).toBe(500);

    const reused = new RuntimeConfigAuthority().resolve(
      {
        ...noProposal,
        candidate: {
          revision: 5,
          overrides: { policy: { recovery: { protectedSpawnEnergy: 700 } } },
        },
      },
      3,
    );
    expect(reused.metadata.reasonCode).toBe("candidate-revision-reused");
    expect(reused.config.policy.recovery.protectedSpawnEnergy).toBe(500);

    const rollback = new RuntimeConfigAuthority().resolve(
      { ...noProposal, candidate: { revision: 6, overrides: {} } },
      4,
    );
    expect(rollback.metadata).toMatchObject({
      status: "candidate-accepted",
      reasonCode: "candidate-valid",
      candidateRevision: 6,
      acceptedCandidateRevision: 6,
    });
    expect(rollback.config.policy.recovery.protectedSpawnEnergy).toBe(300);
    expect(rollback.replacementOwner?.lastValid).toMatchObject({
      candidateRevision: 6,
      overrides: {},
    });
  });

  it("rejects an invalid candidate atomically and retains a compatible last-valid", () => {
    const first = new RuntimeConfigAuthority().resolve(
      owner(1, {
        policy: { recovery: { protectedSpawnEnergy: 500 } },
        relations: { allies: ["Friend"] },
      }),
      1,
    );
    const persisted = jsonClone(first.replacementOwner);
    if (persisted === null) {
      throw new Error("expected accepted config owner");
    }
    const invalidOwner = {
      ...persisted,
      candidate: {
        revision: 2,
        overrides: {
          policy: {
            recovery: { protectedSpawnEnergy: 600 },
            movement: { maximumPathCost: 0 },
          },
        },
      },
    };

    const rejected = new RuntimeConfigAuthority().resolve(invalidOwner, 2);
    expect(rejected.metadata).toMatchObject({
      status: "last-valid-retained",
      reasonCode: "candidate-invalid",
      candidateRevision: 2,
      acceptedCandidateRevision: 1,
    });
    expect(rejected.config.policy.recovery.protectedSpawnEnergy).toBe(500);
    expect(rejected.config.relations.allies).toEqual(["Friend"]);
    expect(rejected.replacementOwner).toBeNull();
  });

  it("falls back to defaults for incompatible evidence and preserves malformed owners", () => {
    const accepted = new RuntimeConfigAuthority().resolve(
      owner(1, { policy: { recovery: { protectedSpawnEnergy: 500 } } }),
      1,
    );
    const stale = jsonClone(accepted.replacementOwner);
    if (stale === null || stale.lastValid === null) {
      throw new Error("expected last-valid config");
    }
    const incompatibleOwner = {
      ...stale,
      candidate: { revision: 2, overrides: { unknown: true } },
      lastValid: { ...stale.lastValid, sourceRevision: "old-source" },
    };
    const incompatibleOwnerBytes = JSON.stringify(incompatibleOwner);
    const incompatible = new RuntimeConfigAuthority().resolve(incompatibleOwner, 2);

    expect(incompatible.metadata).toMatchObject({
      status: "source-defaults",
      reasonCode: "candidate-invalid",
    });
    expect(incompatible.config.policy.recovery.protectedSpawnEnergy).toBe(300);
    expect(incompatible.replacementOwner).toBeNull();
    expect(JSON.stringify(incompatibleOwner)).toBe(incompatibleOwnerBytes);

    const incompatibleWithoutProposal = {
      ...incompatibleOwner,
      candidate: null,
    };
    const noProposal = new RuntimeConfigAuthority().resolve(incompatibleWithoutProposal, 2);
    expect(noProposal.metadata).toEqual({
      status: "source-defaults",
      reasonCode: "no-candidate",
      candidateRevision: null,
      acceptedCandidateRevision: null,
    });
    expect(noProposal.replacementOwner).toBeNull();
    expect(noProposal.config.policy.recovery.protectedSpawnEnergy).toBe(300);

    const malformed = new RuntimeConfigAuthority().resolve({ schemaVersion: 1 }, 2);
    const future = new RuntimeConfigAuthority().resolve(
      { schemaVersion: 2, candidate: null, lastValid: null },
      2,
    );
    const hidden = new RuntimeConfigAuthority().resolve(
      Object.defineProperty({}, "hidden", { value: true }),
      2,
    );
    expect(malformed.metadata).toMatchObject({
      status: "source-defaults",
      reasonCode: "owner-malformed",
    });
    expect(future.metadata).toMatchObject({
      status: "source-defaults",
      reasonCode: "owner-future-schema",
    });
    expect(hidden.metadata.reasonCode).toBe("owner-malformed");
    expect(malformed.replacementOwner).toBeNull();
    expect(future.replacementOwner).toBeNull();
  });

  it("revalidates a candidate but never revives a null receipt from source revision v3", () => {
    const accepted = new RuntimeConfigAuthority().resolve(
      owner(7, { policy: { recovery: { protectedSpawnEnergy: 500 } } }),
      1,
    );
    const persisted = jsonClone(accepted.replacementOwner);
    if (persisted === null || persisted.lastValid === null) {
      throw new Error("expected accepted config evidence");
    }
    const v3Receipt = {
      ...persisted,
      lastValid: { ...persisted.lastValid, sourceRevision: "runtime-config-source-v3" },
    };

    const revalidated = new RuntimeConfigAuthority().resolve(v3Receipt, 2);
    expect(revalidated.metadata).toMatchObject({
      status: "candidate-accepted",
      reasonCode: "candidate-valid",
      acceptedCandidateRevision: 7,
    });
    expect(revalidated.config.sourceRevision).toBe("runtime-config-source-v14");
    expect(revalidated.replacementOwner?.lastValid?.sourceRevision).toBe(
      "runtime-config-source-v14",
    );

    const noCandidate = new RuntimeConfigAuthority().resolve({ ...v3Receipt, candidate: null }, 2);
    expect(noCandidate.metadata).toEqual({
      status: "source-defaults",
      reasonCode: "no-candidate",
      candidateRevision: null,
      acceptedCandidateRevision: null,
    });
    expect(noCandidate.replacementOwner).toBeNull();
  });

  it("rejects stale candidate revisions without reactivating their bytes", () => {
    const accepted = new RuntimeConfigAuthority().resolve(
      owner(5, { policy: { recovery: { protectedSpawnEnergy: 500 } } }),
      1,
    );
    const persisted = jsonClone(accepted.replacementOwner);
    if (persisted === null) {
      throw new Error("expected accepted config owner");
    }
    const staleOwner = {
      ...persisted,
      candidate: {
        revision: 4,
        overrides: { policy: { recovery: { protectedSpawnEnergy: 700 } } },
      },
    };
    const stale = new RuntimeConfigAuthority().resolve(staleOwner, 2);
    expect(stale.metadata.reasonCode).toBe("candidate-stale");
    expect(stale.config.policy.recovery.protectedSpawnEnergy).toBe(500);
  });
});

describe("runtime override validation", () => {
  it("accepts the exact allowlist and rejects unknown, mixed-invalid, and unsafe ranges as a whole", () => {
    expect(
      validateRuntimeOverrides({
        policy: {
          recovery: { protectedSpawnEnergy: 500 },
          safeMode: { enabled: false, retryDelayTicks: 20 },
        },
      }).valid,
    ).toBe(true);
    expect(validateRuntimeOverrides({ unknown: true })).toMatchObject({
      valid: false,
      reason: "unknown-key",
    });
    expect(
      validateRuntimeOverrides({
        policy: {
          recovery: { protectedSpawnEnergy: 500 },
          movement: { maximumPathCost: 0 },
        },
      }),
    ).toMatchObject({ valid: false, reason: "range" });
    expect(
      validateRuntimeOverrides({
        policy: { recovery: { protectedSpawnEnergy: 200, emergencyWorkerEnergyBudget: 300 } },
      }),
    ).toMatchObject({ valid: false, reason: "invariant" });
  });

  it("enforces structural and size budgets before semantic parsing", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sparse: unknown[] = [];
    sparse.length = 1;
    const accessor = Object.defineProperty({}, "policy", {
      enumerable: true,
      get: () => ({}),
    });
    const symbol = { policy: {} } as Record<PropertyKey, unknown>;
    symbol[Symbol("secret")] = true;

    expect(validateRuntimeOverrides(cycle)).toMatchObject({ valid: false, reason: "shape" });
    expect(validateRuntimeOverrides(sparse)).toMatchObject({ valid: false, reason: "shape" });
    expect(validateRuntimeOverrides(accessor)).toMatchObject({ valid: false, reason: "shape" });
    expect(validateRuntimeOverrides(symbol)).toMatchObject({ valid: false, reason: "shape" });
    expect(
      validateRuntimeOverrides({ policy: { recovery: { protectedSpawnEnergy: -0 } } }),
    ).toMatchObject({ valid: false, reason: "type" });
    expect(
      validateRuntimeOverrides({
        relations: { self: Array.from({ length: MAX_CONFIG_OVERRIDE_ARRAY_ITEMS + 1 }, () => "A") },
      }),
    ).toMatchObject({ valid: false, reason: "budget-exceeded" });
    expect(
      validateRuntimeOverrides({
        relations: { self: ["x".repeat(MAX_CONFIG_OVERRIDE_UTF8_BYTES)] },
      }),
    ).toMatchObject({ valid: false, reason: "budget-exceeded" });
  });

  it("rejects oversized strings without passing them to an unbounded serializer", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    let result: ReturnType<typeof validateRuntimeOverrides>;
    let stringifyCalls: number;
    try {
      result = validateRuntimeOverrides({
        relations: { self: ["x".repeat(1_000_000)] },
      });
      stringifyCalls = stringify.mock.calls.length;
    } finally {
      stringify.mockRestore();
    }

    expect(result).toMatchObject({ valid: false, reason: "budget-exceeded" });
    expect(stringifyCalls).toBe(0);
  });

  it("rejects excessive own keys before sorting them", () => {
    const excessive = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`k${String(index)}`, null]),
    );
    const sort = vi.spyOn(Array.prototype, "sort");
    let result: ReturnType<typeof validateRuntimeOverrides>;
    let sortCalls: number;
    try {
      result = validateRuntimeOverrides(excessive);
      sortCalls = sort.mock.calls.length;
    } finally {
      sort.mockRestore();
    }

    expect(result).toMatchObject({ valid: false, reason: "budget-exceeded" });
    expect(sortCalls).toBe(0);
  });

  it("keeps bounded JSON string encoding canonical for every escape class and Unicode", () => {
    const candidate = { relations: { allies: ['Quote"Slash\\é😀'] } };
    const result = validateRuntimeOverrides(candidate);
    const structuralOnly = {
      unknown: '\u0000\b\t\n\f\r"\\\ud800x\udc00\u2028',
    };
    const rejected = validateRuntimeOverrides(structuralOnly);

    expect(result.valid).toBe(true);
    expect(result.inputCanonical).toBe(JSON.stringify(candidate));
    expect(rejected).toMatchObject({ valid: false, reason: "unknown-key" });
    expect(rejected.inputCanonical).toBe(JSON.stringify(structuralOnly));
  });

  it("bounds depth, cumulative keys, nodes, key length, and object prototypes", () => {
    let deep: unknown = {};
    for (let index = 0; index < 7; index += 1) {
      deep = { x: deep };
    }
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`k${String(index)}`, null]),
    );
    const tooManyNodes = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `k${String(index)}`,
        Array.from({ length: 8 }, () => null),
      ]),
    );
    class NonPlain {
      public readonly marker = true;
    }

    for (const candidate of [deep, tooManyKeys, tooManyNodes, { ["k".repeat(65)]: null }]) {
      expect(validateRuntimeOverrides(candidate)).toMatchObject({
        valid: false,
        reason: "budget-exceeded",
      });
    }
    expect(validateRuntimeOverrides(new NonPlain())).toMatchObject({
      valid: false,
      reason: "shape",
    });
  });

  it.each([
    {
      policy: { recovery: { protectedSpawnEnergy: 200, emergencyWorkerEnergyBudget: 300 } },
    },
    {
      policy: {
        recovery: { protectedSpawnEnergy: 500, emergencyWorkerEnergyBudget: 400 },
        spawn: { maximumBodyEnergy: 300 },
      },
    },
    { policy: { leases: { durationTicks: 10, renewalWindowTicks: 10 } } },
    { policy: { retries: { initialDelayTicks: 10, maximumDelayTicks: 9 } } },
    { policy: { movement: { stuckReplanTicks: 11, blockedReleaseTicks: 10 } } },
    {
      policy: { repair: { criticalHitsBasisPoints: 4_000, completionHitsBasisPoints: 3_999 } },
    },
    { policy: { tower: { emergencyReserveEnergy: 801, repairMinimumEnergy: 800 } } },
  ])("rejects every cross-field invariant atomically", (candidate) => {
    expect(validateRuntimeOverrides(candidate)).toMatchObject({
      valid: false,
      reason: "invariant",
    });
  });

  it("canonicalizes identities and rejects malformed, duplicate, and overlapping exclusions", () => {
    const valid = validateRuntimeOverrides({
      relations: { self: ["Zulu", "Alpha"], allies: ["alpha"], naps: ["Nap"] },
    });
    expect(valid.valid && valid.overrides.relations?.self).toEqual(["Alpha", "Zulu"]);
    expect(validateRuntimeOverrides({ relations: { allies: [" Friend"] } })).toMatchObject({
      valid: false,
      reason: "identity",
    });
    expect(validateRuntimeOverrides({ relations: { allies: ["e\u0301"] } })).toMatchObject({
      valid: false,
      reason: "identity",
    });
    expect(validateRuntimeOverrides({ relations: { allies: ["A", "A"] } })).toMatchObject({
      valid: false,
      reason: "identity",
    });
    expect(
      validateRuntimeOverrides({ relations: { self: ["Same"], naps: ["Same"] } }),
    ).toMatchObject({ valid: false, reason: "identity-overlap" });
    expect(validateRuntimeOverrides({ relations: { allies: ["A\u0000B"] } })).toMatchObject({
      valid: false,
      reason: "identity",
    });
    expect(validateRuntimeOverrides({ relations: { allies: ["\ud800"] } })).toMatchObject({
      valid: false,
      reason: "identity",
    });
    expect(
      validateRuntimeOverrides({
        relations: {
          self: identities("self", 22),
          allies: identities("ally", 22),
          naps: identities("nap", 21),
        },
      }),
    ).toMatchObject({ valid: false, reason: "identity" });
  });

  it("rejects nested unknown keys and every non-disable feature override", () => {
    expect(
      validateRuntimeOverrides({ policy: { recovery: { anonymousThreshold: 1 } } }),
    ).toMatchObject({ valid: false, reason: "unknown-key" });
    expect(validateRuntimeOverrides({ features: { enabled: ["phase1.colony"] } })).toMatchObject({
      valid: false,
      reason: "unknown-key",
    });
    expect(validateRuntimeOverrides({ features: { disabled: ["phase1.unknown"] } })).toMatchObject({
      valid: false,
      reason: "gate-id",
    });
    expect(
      validateRuntimeOverrides({
        features: { disabled: ["phase1.growth", "phase1.growth"] },
      }),
    ).toMatchObject({ valid: false, reason: "gate-id" });
  });
});

describe("source feature gates", () => {
  it("makes completed safety, recovery, maintenance, growth, and telemetry source-available under v14", () => {
    const config = buildRuntimeConfig({ features: { disabled: ["phase1.growth"] } });
    expect(config.sourceRevision).toBe("runtime-config-source-v14");
    expect(isFeatureEnabled(config, "phase1.colony")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.contracts")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.spawn")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.movement")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.agents")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.economy")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.safety")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.recovery")).toBe(true);
    expect(isFeatureEnabled(config, "phase1.critical-maintenance")).toBe(true);
    expect(
      FEATURE_GATE_IDS.filter(
        (id) =>
          ![
            "phase1.colony",
            "phase1.contracts",
            "phase1.spawn",
            "phase1.movement",
            "phase1.agents",
            "phase1.economy",
            "phase1.safety",
            "phase1.recovery",
            "phase1.growth",
            "phase1.telemetry",
            "phase1.critical-maintenance",
          ].includes(id),
      ).every((id) => !isFeatureEnabled(config, id)),
    ).toBe(true);
    expect(config.features.gates["phase1.growth"]).toEqual({
      blockedBy: null,
      enabled: false,
      reason: "operator-disabled",
    });

    const contractsDisabled = buildRuntimeConfig({
      features: { disabled: ["phase1.contracts"] },
    });
    expect(contractsDisabled.features.gates["phase1.contracts"]).toEqual({
      blockedBy: null,
      enabled: false,
      reason: "operator-disabled",
    });
    const colonyDisabled = buildRuntimeConfig({ features: { disabled: ["phase1.colony"] } });
    expect(colonyDisabled.features.gates["phase1.contracts"]).toEqual({
      blockedBy: "phase1.colony",
      enabled: false,
      reason: "prerequisite-blocked",
    });
  });

  it("cannot pass a disabled or incomplete prerequisite in an available test manifest", () => {
    const available = manifestWithAvailability(["phase1.colony", "phase1.contracts"]);
    const enabled = resolveFeatureGates([], available);
    const disabled = resolveFeatureGates(["phase1.colony"], available);

    expect(enabled.gates["phase1.contracts"]).toMatchObject({ enabled: true, reason: "enabled" });
    expect(disabled.gates["phase1.colony"]).toMatchObject({
      enabled: false,
      reason: "operator-disabled",
    });
    expect(disabled.gates["phase1.contracts"]).toMatchObject({
      enabled: false,
      reason: "prerequisite-blocked",
      blockedBy: "phase1.colony",
    });
  });

  it("rejects cyclic and unknown source prerequisite manifests", () => {
    const cyclic = SOURCE_FEATURE_GATES.map((definition) =>
      definition.id === "phase1.colony"
        ? { ...definition, prerequisites: ["phase1.contracts" as const] }
        : definition,
    );
    const unknown = SOURCE_FEATURE_GATES.map((definition) =>
      definition.id === "phase1.colony"
        ? { ...definition, prerequisites: ["phase1.unknown" as FeatureGateId] }
        : definition,
    );
    expect(() => resolveFeatureGates([], cyclic)).toThrow(/cycle/u);
    expect(() => resolveFeatureGates([], unknown)).toThrow(/unknown/u);
  });
});

describe("fail-closed configured relations", () => {
  const config = buildRuntimeConfig({
    relations: { self: ["Owner"], allies: ["Friend"], naps: ["Neighbor"] },
  });

  it.each([
    ["Owner", "self"],
    ["Friend", "ally"],
    ["Neighbor", "nap"],
  ] as const)("keeps configured %s excluded before optional reputation", (username, relation) => {
    for (const reputation of [
      undefined,
      {},
      { schemaVersion: 2, relation: "war", assessedAt: 10, expiresAt: 20 },
      { schemaVersion: 1, relation: "war", assessedAt: 11, expiresAt: 20 },
      { schemaVersion: 1, relation: "war", assessedAt: 1, expiresAt: 9 },
      { schemaVersion: 1, relation: "war", assessedAt: 1, expiresAt: 20 },
    ]) {
      expect(classifyPlayerRelation(config, { username, tick: 10, reputation })).toMatchObject({
        relation,
        targetingCeiling: "excluded",
        reputationStatus: "not-consulted",
      });
    }
  });

  it("caps every unconfigured offensive relation at local defense", () => {
    for (const relation of ["neutral", "trespasser", "hostile", "war"] as const) {
      expect(
        classifyPlayerRelation(config, {
          username: "Unknown",
          tick: 10,
          reputation: { schemaVersion: 1, relation, assessedAt: 5, expiresAt: 15 },
        }),
      ).toMatchObject({ relation, targetingCeiling: "local-defense", reputationStatus: "fresh" });
    }
  });

  it("treats absent, malformed, stale, and future-dated reputation as neutral", () => {
    const variants = [
      [undefined, "absent"],
      [{}, "invalid"],
      [{ schemaVersion: 2, relation: "war", assessedAt: 1, expiresAt: 20 }, "invalid"],
      [{ schemaVersion: 1, relation: "war", assessedAt: 11, expiresAt: 20 }, "invalid"],
      [{ schemaVersion: 1, relation: "war", assessedAt: 1, expiresAt: 9 }, "stale"],
    ] as const;
    for (const [reputation, status] of variants) {
      expect(
        classifyPlayerRelation(config, { username: "Unknown", tick: 10, reputation }),
      ).toMatchObject({
        relation: "neutral",
        targetingCeiling: "local-defense",
        reputationStatus: status,
      });
    }
  });

  it("allows optional reputation only to reduce the ceiling and excludes malformed observed identity", () => {
    expect(
      classifyPlayerRelation(config, {
        username: "Unknown",
        tick: 10,
        reputation: { schemaVersion: 1, relation: "ally", assessedAt: 1, expiresAt: 20 },
      }),
    ).toMatchObject({ relation: "ally", targetingCeiling: "excluded" });
    expect(classifyPlayerRelation(config, { username: " bad", tick: 10 })).toMatchObject({
      relation: "neutral",
      targetingCeiling: "excluded",
      reasonCode: "invalid-observed-identity",
    });
  });
});

function owner(
  revision: number,
  overrides: unknown,
  lastValid: RuntimeConfigOwnerV1["lastValid"] = null,
): RuntimeConfigOwnerV1 {
  return {
    schemaVersion: 1,
    candidate: { revision, overrides },
    lastValid,
  };
}

function jsonClone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function assertDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    assertDeeplyFrozen(child);
  }
}

function manifestWithAvailability(available: readonly FeatureGateId[]): FeatureGateDefinition[] {
  const enabled = new Set(available);
  return SOURCE_FEATURE_GATES.map((definition) => ({
    ...definition,
    available: enabled.has(definition.id),
  }));
}

function identities(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`);
}
