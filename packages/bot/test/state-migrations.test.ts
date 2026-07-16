import { describe, expect, it } from "vitest";
import { MAX_MIGRATION_STEP_BUDGET, openMyrmexMemory } from "../src/state/memory";
import {
  LEGACY_MEMORY_MIGRATION_ID,
  LEGACY_MEMORY_MIGRATION_STEP_COUNT,
  INTERMEDIATE_MEMORY_MIGRATION_ID,
  INTERMEDIATE_MEMORY_SCHEMA_VERSION,
  LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION,
  LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS,
  MEMORY_MIGRATION_ID,
  MEMORY_TARGET_SCHEMA_VERSION,
  PERSISTENT_STATE_OWNERS,
  PREVIOUS_MEMORY_SCHEMA_VERSION,
  PREVIOUS_PERSISTENT_STATE_OWNERS,
} from "../src/state/schema";
import {
  MAX_PERSISTENT_JSON_CODE_UNITS,
  MAX_PERSISTENT_JSON_NODES,
  isCurrentMyrmexMemory,
  isMigratingMyrmexMemory,
  isPreviousMyrmexMemory,
  validateJsonValue,
} from "../src/state/validation";

describe("durable state migrations", () => {
  it("removes legacy tick snapshots and telemetry before advancing bounded steps", () => {
    const memory = legacyMemory();

    const started = openMyrmexMemory(memory, 101, "shard3");

    expect(started.status).toBe("recovery");
    if (started.status !== "recovery") {
      throw new Error("expected migration recovery");
    }
    expect(started.migrationStepsApplied).toBe(1);
    expect(started.cursor.nextStep).toBe(0);
    expect(started.marker.reason).toBe("schema-migration");
    expect(memory.myrmex).not.toHaveProperty("world");
    expect(memory.myrmex).not.toHaveProperty("telemetry");

    let result = started;
    for (let tick = 102; tick <= 106; tick += 1) {
      result = openMyrmexMemory(memory, tick, "shard3") as typeof started;
    }

    expect(result.status).toBe("ready");
    expect(memory.myrmex?.meta).toMatchObject({
      schemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      firstTick: 7,
      lastTick: 106,
      shard: "shard3",
      migration: null,
      recovery: null,
    });
    expect(memory.myrmex?.telemetry).toEqual({});
    expect(Object.keys(memory.myrmex ?? {}).sort()).toEqual(
      ["meta", ...PERSISTENT_STATE_OWNERS].sort(),
    );
  });

  it("resumes an interrupted cursor deterministically after JSON round-tripping", () => {
    const original = legacyMemory();
    openMyrmexMemory(original, 200, "shard2");
    const firstProgress = openMyrmexMemory(original, 201, "shard2");
    expect(firstProgress.status).toBe("recovery");

    const persisted = JSON.parse(JSON.stringify(original)) as Memory;
    const firstResume = openMyrmexMemory(persisted, 202, "shard2");
    expect(firstResume.status).toBe("recovery");
    if (firstResume.status !== "recovery") {
      throw new Error("expected resumed recovery");
    }
    expect(firstResume.cursor.nextStep).toBe(2);

    const repeatedA = JSON.parse(JSON.stringify(original)) as Memory;
    const repeatedB = JSON.parse(JSON.stringify(original)) as Memory;
    openMyrmexMemory(repeatedA, 202, "shard2");
    openMyrmexMemory(repeatedB, 202, "shard2");
    expect(repeatedA.myrmex).toEqual(repeatedB.myrmex);
  });

  it("migrates an exact schema-2 root without classifying it as corrupt", () => {
    const memory = schema2Memory();
    const beforeOwners = Object.fromEntries(
      PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [
        owner,
        JSON.stringify((memory.myrmex as unknown as Record<string, unknown>)[owner]),
      ]),
    );

    const started = openMyrmexMemory(memory, 701, "shard2");

    expect(started.status).toBe("recovery");
    if (started.status !== "recovery") {
      throw new Error("expected schema migration recovery");
    }
    expect(started.migrationStepsApplied).toBe(1);
    expect(started.marker.reason).toBe("schema-migration");
    expect(started.cursor).toMatchObject({
      id: MEMORY_MIGRATION_ID,
      fromVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
      targetVersion: MEMORY_TARGET_SCHEMA_VERSION,
      nextStep: 0,
    });
    for (const owner of PREVIOUS_PERSISTENT_STATE_OWNERS) {
      expect(JSON.stringify((memory.myrmex as unknown as Record<string, unknown>)[owner])).toBe(
        beforeOwners[owner],
      );
    }

    const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    const completed = openMyrmexMemory(resetMemory, 702, "shard2");

    expect(completed.status).toBe("ready");
    expect(resetMemory.myrmex?.meta).toMatchObject({
      schemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: 17,
      firstTick: 611,
      lastTick: 702,
      shard: "shard2",
      migration: null,
      recovery: null,
    });
    expect(resetMemory.myrmex?.config).toEqual({});
    expect(resetMemory.myrmex?.meta.diagnostics).toEqual([
      { code: "migration-complete", tick: 650, detail: "schema-migration" },
      { code: "recovery-start", tick: 701, detail: "schema-migration" },
      { code: "migration-complete", tick: 702, detail: "schema-migration" },
    ]);
    for (const owner of PREVIOUS_PERSISTENT_STATE_OWNERS) {
      expect(
        JSON.stringify((resetMemory.myrmex as unknown as Record<string, unknown>)[owner]),
      ).toBe(beforeOwners[owner]);
    }
  });

  it("initializes layouts while preserving every schema-3 owner", () => {
    const owners = Object.fromEntries(
      LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [owner, { marker: owner }]),
    );
    const memory = {
      myrmex: {
        meta: {
          schemaVersion: LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION,
          targetSchemaVersion: LAYOUT_PREVIOUS_MEMORY_SCHEMA_VERSION,
          revision: 18,
          firstTick: 710,
          lastTick: 720,
          shard: "shard2",
          diagnostics: [],
          migration: null,
          recovery: null,
        },
        ...owners,
      },
    } as unknown as Memory;

    expect(openMyrmexMemory(memory, 721, "shard2").status).toBe("recovery");
    expect(openMyrmexMemory(memory, 722, "shard2").status).toBe("ready");
    expect(memory.myrmex?.layouts).toEqual({});
    for (const owner of LAYOUT_PREVIOUS_PERSISTENT_STATE_OWNERS) {
      expect((memory.myrmex as unknown as Record<string, unknown>)[owner]).toEqual({
        marker: owner,
      });
    }
  });

  it.each(["nodes", "codeUnits"] as const)(
    "preserves every schema-2 owner and omits completion evidence at the final %s cap",
    (dimension) => {
      const memory = schema2BoundaryMemory(dimension);
      const telemetryBytes = JSON.stringify(memory.myrmex?.telemetry);

      expect(isPreviousMyrmexMemory(memory.myrmex)).toBe(true);
      expect(jsonFootprint(expectedBoundaryFinal(memory, false))[dimension]).toBe(
        dimension === "nodes" ? MAX_PERSISTENT_JSON_NODES : MAX_PERSISTENT_JSON_CODE_UNITS,
      );
      expect(isCurrentMyrmexMemory(expectedBoundaryFinal(memory, true))).toBe(false);

      const started = openMyrmexMemory(memory, 1_001, "shard3");

      expect(started.status).toBe("recovery");
      expect(isMigratingMyrmexMemory(memory.myrmex)).toBe(true);
      expect(validateJsonValue(memory.myrmex).valid).toBe(false);
      expect(JSON.stringify(memory.myrmex?.telemetry)).toBe(telemetryBytes);

      const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
      const completed = openMyrmexMemory(resetMemory, 1_002, "shard3");

      expect(completed.status).toBe("ready");
      expect(isCurrentMyrmexMemory(resetMemory.myrmex)).toBe(true);
      expect(JSON.stringify(resetMemory.myrmex?.telemetry)).toBe(telemetryBytes);
      expect(resetMemory.myrmex?.meta.diagnostics).toEqual([
        { code: "recovery-start", tick: 1_001, detail: "schema-migration" },
      ]);
      expect(jsonFootprint(resetMemory.myrmex)[dimension]).toBe(
        dimension === "nodes" ? MAX_PERSISTENT_JSON_NODES : MAX_PERSISTENT_JSON_CODE_UNITS,
      );
    },
  );

  it.each(["nodes", "codeUnits"] as const)(
    "restarts a current cursor whose owner state exceeds the final %s cap",
    (dimension) => {
      const memory = schema2BoundaryMemory(dimension);
      expect(openMyrmexMemory(memory, 1_001, "shard3").status).toBe("recovery");
      exceedBoundary(memory, dimension);

      expect(isMigratingMyrmexMemory(memory.myrmex)).toBe(false);
      const restarted = openMyrmexMemory(memory, 1_002, "shard3");

      expect(restarted.status).toBe("recovery");
      if (restarted.status !== "recovery") {
        throw new Error("expected oversized cursor recovery restart");
      }
      expect(restarted.marker.reason).toBe("corrupt-root");
      expect(isMigratingMyrmexMemory(memory.myrmex)).toBe(true);

      const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
      expect(() => openMyrmexMemory(resetMemory, 1_003, "shard3")).not.toThrow();
      expect(isCurrentMyrmexMemory(resetMemory.myrmex)).toBe(true);
    },
  );

  it("resumes a deployed v1-to-v2 cursor before chaining into schema 3", () => {
    const memory = historicalCursorMemory();

    const resumed = openMyrmexMemory(memory, 801, "shard1");
    expect(resumed.status).toBe("recovery");
    if (resumed.status !== "recovery") {
      throw new Error("expected historical cursor recovery");
    }
    expect(resumed.cursor).toMatchObject({
      id: LEGACY_MEMORY_MIGRATION_ID,
      nextStep: 3,
      startedAt: 790,
    });
    expect(memory.myrmex?.empire).toEqual({ objective: "survive", revision: 4 });

    const firstReset = JSON.parse(JSON.stringify(memory)) as Memory;
    const transitioned = openMyrmexMemory(firstReset, 802, "shard1");
    expect(transitioned.status).toBe("recovery");
    if (transitioned.status !== "recovery") {
      throw new Error("expected chained cursor recovery");
    }
    expect(transitioned.cursor).toMatchObject({
      id: INTERMEDIATE_MEMORY_MIGRATION_ID,
      nextStep: 0,
    });
    expect(transitioned.marker).toMatchObject({ reason: "schema-migration", sinceTick: 790 });

    const secondReset = JSON.parse(JSON.stringify(firstReset)) as Memory;
    expect(openMyrmexMemory(secondReset, 803, "shard1").status).toBe("ready");
    expect(secondReset.myrmex?.empire).toEqual({ objective: "survive", revision: 4 });
    expect(secondReset.myrmex?.config).toEqual({});
    expect(secondReset.myrmex?.meta.diagnostics).toEqual([
      { code: "recovery-start", tick: 790, detail: "schema-migration" },
      { code: "migration-complete", tick: 803, detail: "schema-migration" },
    ]);
  });

  it("salvages present owners while restarting a malformed historical cursor", () => {
    const memory = historicalCursorMemory();
    const meta = (memory.myrmex as unknown as { meta: { migration: { updatedAt: unknown } } }).meta;
    meta.migration.updatedAt = "damaged";

    const restarted = openMyrmexMemory(memory, 810, "shard1");

    expect(restarted.status).toBe("recovery");
    if (restarted.status !== "recovery") {
      throw new Error("expected historical recovery restart");
    }
    expect(restarted.cursor).toMatchObject({ id: LEGACY_MEMORY_MIGRATION_ID, nextStep: 0 });
    expect(restarted.marker.reason).toBe("corrupt-root");
    expect(memory.myrmex?.empire).toEqual({ objective: "survive", revision: 4 });

    const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    let result = restarted;
    for (let tick = 811; tick <= 815; tick += 1) {
      result = openMyrmexMemory(resetMemory, tick, "shard1") as typeof restarted;
    }

    expect(result.status).toBe("ready");
    expect(resetMemory.myrmex?.empire).toEqual({ objective: "survive", revision: 4 });
    expect(resetMemory.myrmex?.config).toEqual({});
  });

  it.each(["nodes", "codeUnits"] as const)(
    "preserves every near-cap owner while restarting and transitioning a malformed legacy %s cursor",
    (dimension) => {
      const initial = malformedLegacyBoundaryMemory(dimension);
      const telemetryBytes = JSON.stringify(initial.myrmex?.telemetry);

      const restarted = openMyrmexMemory(initial, 1_101, "shard3");

      expect(restarted.status).toBe("recovery");
      if (restarted.status !== "recovery") {
        throw new Error("expected near-cap historical recovery restart");
      }
      expect(restarted.cursor).toMatchObject({ id: LEGACY_MEMORY_MIGRATION_ID, nextStep: 0 });
      expect(restarted.marker.reason).toBe("corrupt-root");
      expect(JSON.stringify(initial.myrmex?.telemetry)).toBe(telemetryBytes);

      let resetMemory = JSON.parse(JSON.stringify(initial)) as Memory;
      let status: ReturnType<typeof openMyrmexMemory>["status"] = restarted.status;
      for (let tick = 1_102; tick <= 1_106; tick += 1) {
        const progress = openMyrmexMemory(resetMemory, tick, "shard3");
        status = progress.status;
        resetMemory = JSON.parse(JSON.stringify(resetMemory)) as Memory;
      }

      expect(status).toBe("ready");
      expect(isCurrentMyrmexMemory(resetMemory.myrmex)).toBe(true);
      expect(JSON.stringify(resetMemory.myrmex?.telemetry)).toBe(telemetryBytes);
      expect(resetMemory.myrmex?.meta.diagnostics).toEqual([
        { code: "recovery-start", tick: 1_101, detail: "corrupt-root" },
      ]);
      expect(jsonFootprint(resetMemory.myrmex)[dimension]).toBe(
        dimension === "nodes" ? MAX_PERSISTENT_JSON_NODES : MAX_PERSISTENT_JSON_CODE_UNITS,
      );
    },
  );

  it("clamps requested work and cannot finish a legacy migration in one tick", () => {
    const memory = legacyMemory();
    const result = openMyrmexMemory(memory, 300, "shard1", {
      migrationStepBudget: Number.MAX_SAFE_INTEGER,
    });

    expect(MAX_MIGRATION_STEP_BUDGET).toBe(4);
    expect(result.status).toBe("recovery");
    expect(result.migrationStepsApplied).toBe(MAX_MIGRATION_STEP_BUDGET);
    expect(memory.myrmex?.meta.migration?.nextStep).toBe(3);

    const transitioned = openMyrmexMemory(memory, 301, "shard1");
    expect(transitioned.status).toBe("recovery");
    if (transitioned.status !== "recovery") {
      throw new Error("expected chained migration recovery");
    }
    expect(transitioned.cursor).toMatchObject({
      id: INTERMEDIATE_MEMORY_MIGRATION_ID,
      nextStep: 0,
    });
    expect(openMyrmexMemory(memory, 302, "shard1").status).toBe("ready");
  });

  it.each([
    ["non-object", "damaged"],
    ["partial root", { meta: { schemaVersion: 2 } }],
    [
      "corrupt optional recovery field",
      {
        meta: {
          schemaVersion: 2,
          targetSchemaVersion: 2,
          revision: 0,
          firstTick: 10,
          lastTick: 10,
          shard: "shard0",
          migration: null,
          recovery: { active: "yes" },
        },
      },
    ],
  ])("enters safe recovery for a %s", (_name, root) => {
    const memory = { myrmex: root } as unknown as Memory;
    const result = openMyrmexMemory(memory, 400, "shard0");

    expect(result.status).toBe("recovery");
    if (result.status !== "recovery") {
      throw new Error("expected corrupt-root recovery");
    }
    expect(result.marker.reason).toBe("corrupt-root");
    expect(memory.myrmex).not.toHaveProperty("world");
    expect(JSON.stringify(memory.myrmex)).toBeTruthy();
  });

  it.each([
    ["schema version", { meta: { schemaVersion: 99 } }, 99],
    ["conflicting legacy marker", { schema: 1, meta: { schemaVersion: 99 } }, 99],
    ["target schema version", { meta: { schemaVersion: 4, targetSchemaVersion: 5 } }, 5],
    [
      "migration target version",
      {
        meta: {
          schemaVersion: 4,
          targetSchemaVersion: 4,
          migration: { fromVersion: 4, targetVersion: 5 },
        },
      },
      5,
    ],
  ] as const)("fails closed without downgrading a future %s", (_name, root, expectedVersion) => {
    const memory = { myrmex: root } as unknown as Memory;

    const result = openMyrmexMemory(memory, 500, "shard0");

    expect(result).toEqual({
      status: "unsupported",
      foundSchemaVersion: expectedVersion,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      migrationStepsApplied: 0,
    });
    expect(memory.myrmex).toBe(root);
  });

  it("preserves config while restarting a malformed v2-to-v3 cursor", () => {
    const memory = malformedCurrentCursorMemory();
    const configBytes = JSON.stringify(memory.myrmex?.config);

    const restarted = openMyrmexMemory(memory, 901, "shard2");

    expect(restarted.status).toBe("recovery");
    if (restarted.status !== "recovery") {
      throw new Error("expected current migration recovery restart");
    }
    expect(restarted.cursor).toMatchObject({ id: MEMORY_MIGRATION_ID, nextStep: 0 });
    expect(restarted.marker.reason).toBe("corrupt-root");
    expect(JSON.stringify(memory.myrmex?.config)).toBe(configBytes);

    const resetMemory = JSON.parse(JSON.stringify(memory)) as Memory;
    expect(openMyrmexMemory(resetMemory, 902, "shard2").status).toBe("ready");
    expect(JSON.stringify(resetMemory.myrmex?.config)).toBe(configBytes);
  });

  it("salvages aggregate-invalid owners in deterministic canonical priority", () => {
    const first = aggregateOverflowMemory();
    const repeated = JSON.parse(JSON.stringify(first)) as Memory;
    const preservedBytes = JSON.stringify(first.myrmex?.config);

    const firstResult = openMyrmexMemory(first, 951, "shard3");
    const repeatedResult = openMyrmexMemory(repeated, 951, "shard3");

    expect(firstResult.status).toBe("recovery");
    expect(repeatedResult.status).toBe("recovery");
    expect(isMigratingMyrmexMemory(first.myrmex)).toBe(true);
    expect(JSON.stringify(first.myrmex)).toBe(JSON.stringify(repeated.myrmex));
    expect(JSON.stringify(first.myrmex?.config)).toBe(preservedBytes);
    expect(JSON.stringify(first.myrmex?.contracts)).toBe(preservedBytes);
    expect(first.myrmex?.diplomacy).toEqual({});

    const resetMemory = JSON.parse(JSON.stringify(first)) as Memory;
    expect(openMyrmexMemory(resetMemory, 952, "shard3").status).toBe("ready");
    expect(isCurrentMyrmexMemory(resetMemory.myrmex)).toBe(true);
    expect(JSON.stringify(resetMemory.myrmex?.config)).toBe(preservedBytes);
    expect(resetMemory.myrmex?.diplomacy).toEqual({});
  });

  it("preserves valid authority state while rebuilding a malformed optional subtree", () => {
    const memory = {} as Memory;
    const opened = openMyrmexMemory(memory, 600, "shard3");
    if (opened.status !== "ready") {
      throw new Error("expected current memory");
    }
    opened.manager.transaction("empire").replace({ objective: "survive", revision: 7 }).stage();
    opened.manager
      .transaction("config")
      .replace({ candidate: { revision: 3, overrides: { survival: { reserve: 12_000 } } } })
      .stage();
    expect(opened.manager.commitReconciliation()).toMatchObject({ committed: true });
    const root = memory.myrmex as unknown as Record<string, unknown>;
    root.telemetry = { invalid: undefined };

    expect(openMyrmexMemory(memory, 601, "shard3").status).toBe("recovery");
    expect(openMyrmexMemory(memory, 602, "shard3").status).toBe("ready");

    expect(memory.myrmex?.empire).toEqual({ objective: "survive", revision: 7 });
    expect(memory.myrmex?.config).toEqual({
      candidate: { revision: 3, overrides: { survival: { reserve: 12_000 } } },
    });
    expect(memory.myrmex?.telemetry).toEqual({});
    expect(memory.myrmex?.meta.firstTick).toBe(600);
    expect(memory.myrmex?.meta.diagnostics).toEqual([
      { code: "recovery-start", tick: 601, detail: "corrupt-root" },
      { code: "migration-complete", tick: 602, detail: "corrupt-root" },
    ]);
  });
});

type BoundaryDimension = "nodes" | "codeUnits";

function schema2BoundaryMemory(dimension: BoundaryDimension): Memory {
  const owners = Object.fromEntries(PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [owner, {}]));
  const memory = {
    myrmex: {
      meta: {
        schemaVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
        targetSchemaVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
        revision: 31,
        firstTick: 1_000,
        lastTick: 1_000,
        shard: "shard3",
        diagnostics: [],
        migration: null,
        recovery: null,
      },
      ...owners,
    },
  } as unknown as Memory;
  const root = memory.myrmex as unknown as Record<string, unknown>;

  if (dimension === "nodes") {
    for (const owner of ["kernel", "empire", "colonies", "contracts"]) {
      root[owner] = { values: Array.from({ length: 10_000 }, () => 0) };
    }
    root.telemetry = { values: [] };
    const remaining =
      MAX_PERSISTENT_JSON_NODES - jsonFootprint(expectedBoundaryFinal(memory, false)).nodes;
    if (remaining < 0 || remaining > 10_000) {
      throw new Error("node boundary fixture exceeds one bounded array");
    }
    root.telemetry = { values: Array.from({ length: remaining }, () => 0) };
  } else {
    root.telemetry = { payload: "" };
    const remaining =
      MAX_PERSISTENT_JSON_CODE_UNITS -
      jsonFootprint(expectedBoundaryFinal(memory, false)).codeUnits;
    if (remaining < 0) {
      throw new Error("code-unit boundary fixture has no payload capacity");
    }
    root.telemetry = { payload: "x".repeat(remaining) };
  }

  const footprint = jsonFootprint(expectedBoundaryFinal(memory, false));
  const expected =
    dimension === "nodes" ? MAX_PERSISTENT_JSON_NODES : MAX_PERSISTENT_JSON_CODE_UNITS;
  if (footprint[dimension] !== expected) {
    throw new Error(`failed to construct exact ${dimension} boundary fixture`);
  }
  return memory;
}

function malformedLegacyBoundaryMemory(dimension: BoundaryDimension): Memory {
  const memory = schema2BoundaryMemory(dimension);
  const root = memory.myrmex as unknown as Record<string, unknown>;
  if (dimension === "codeUnits") {
    const telemetry = root.telemetry as { payload: string };
    // `corrupt-root` is four code units shorter than the schema-migration detail used by the v2
    // fixture, so restore those four units to keep the eventual diagnostic-free v3 root at the cap.
    telemetry.payload += "xxxx";
  }
  root.meta = {
    schemaVersion: 1,
    targetSchemaVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
    revision: 31,
    firstTick: 1_000,
    lastTick: 1_100,
    shard: "shard3",
    diagnostics: [{ code: "recovery-start", tick: 1_090, detail: "schema-migration" }],
    migration: {
      id: LEGACY_MEMORY_MIGRATION_ID,
      fromVersion: 1,
      targetVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
      nextStep: 3,
      stepCount: LEGACY_MEMORY_MIGRATION_STEP_COUNT,
      startedAt: 1_090,
      updatedAt: "damaged",
    },
    recovery: {
      active: true,
      lastProgressTick: 1_100,
      reason: "schema-migration",
      sinceTick: 1_090,
    },
  };
  return memory;
}

function expectedBoundaryFinal(
  memory: Memory,
  includeCompletion: boolean,
): Record<string, unknown> {
  const source = memory.myrmex as unknown as Record<string, unknown>;
  const diagnostics = [
    { code: "recovery-start", tick: 1_001, detail: "schema-migration" },
    ...(includeCompletion
      ? [{ code: "migration-complete", tick: 1_002, detail: "schema-migration" }]
      : []),
  ];
  const owners = Object.fromEntries(
    PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [owner, source[owner] ?? {}]),
  );
  return {
    meta: {
      schemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      revision: 31,
      firstTick: 1_000,
      lastTick: 1_002,
      shard: "shard3",
      diagnostics,
      migration: null,
      recovery: null,
    },
    layouts: {},
    config: {},
    ...owners,
  };
}

function exceedBoundary(memory: Memory, dimension: BoundaryDimension): void {
  const telemetry = memory.myrmex?.telemetry as {
    payload?: string;
    values?: number[];
  };
  if (dimension === "nodes") {
    if (!Array.isArray(telemetry.values)) {
      throw new Error("node fixture telemetry is missing values");
    }
    telemetry.values.push(0);
  } else {
    if (typeof telemetry.payload !== "string") {
      throw new Error("code-unit fixture telemetry is missing payload");
    }
    telemetry.payload += "x";
  }
}

function jsonFootprint(value: unknown): { readonly nodes: number; readonly codeUnits: number } {
  let nodes = 0;
  let codeUnits = 0;
  const visit = (candidate: unknown): void => {
    nodes += 1;
    if (typeof candidate === "string") {
      codeUnits += candidate.length;
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const [key, item] of Object.entries(candidate)) {
        codeUnits += key.length;
        visit(item);
      }
    }
  };
  visit(value);
  return { nodes, codeUnits };
}

function legacyMemory(): Memory {
  return {
    myrmex: {
      schema: 1,
      boot: { firstTick: 7, lastTick: 100, shard: "shard3" },
      world: { observedAt: 100, ownedRooms: [{ name: "W1N1" }] },
      telemetry: { cpuUsed: 12, cpuBucket: 4_000, ownedRooms: 1 },
    },
  } as unknown as Memory;
}

function schema2Memory(): Memory {
  const owners: Record<string, unknown> = Object.fromEntries(
    PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [owner, { marker: owner }]),
  );
  owners.empire = { objective: "survive", revision: 17 };

  return {
    myrmex: {
      meta: {
        schemaVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
        targetSchemaVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
        revision: 17,
        firstTick: 611,
        lastTick: 700,
        shard: "shard2",
        diagnostics: [{ code: "migration-complete", tick: 650, detail: "schema-migration" }],
        migration: null,
        recovery: null,
      },
      ...owners,
    },
  } as unknown as Memory;
}

function historicalCursorMemory(): Memory {
  return {
    myrmex: {
      meta: {
        schemaVersion: 1,
        targetSchemaVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
        revision: 9,
        firstTick: 700,
        lastTick: 800,
        shard: "shard1",
        diagnostics: [{ code: "recovery-start", tick: 790, detail: "schema-migration" }],
        migration: {
          id: LEGACY_MEMORY_MIGRATION_ID,
          fromVersion: 1,
          targetVersion: INTERMEDIATE_MEMORY_SCHEMA_VERSION,
          nextStep: 2,
          stepCount: LEGACY_MEMORY_MIGRATION_STEP_COUNT,
          startedAt: 790,
          updatedAt: 800,
        },
        recovery: {
          active: true,
          lastProgressTick: 800,
          reason: "schema-migration",
          sinceTick: 790,
        },
      },
      kernel: { marker: "kernel" },
      empire: { objective: "survive", revision: 4 },
      colonies: { marker: "colonies" },
      contracts: { marker: "contracts" },
      diplomacy: { marker: "diplomacy" },
      remotes: { marker: "remotes" },
      expansion: { marker: "expansion" },
      operations: { marker: "operations" },
      industry: { marker: "industry" },
    },
  } as unknown as Memory;
}

function malformedCurrentCursorMemory(): Memory {
  const owners = Object.fromEntries(
    PREVIOUS_PERSISTENT_STATE_OWNERS.map((owner) => [owner, { marker: owner }]),
  );

  return {
    myrmex: {
      meta: {
        schemaVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
        targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
        revision: 12,
        firstTick: 850,
        lastTick: 900,
        shard: "shard2",
        diagnostics: [{ code: "recovery-start", tick: 900, detail: "schema-migration" }],
        migration: {
          id: MEMORY_MIGRATION_ID,
          fromVersion: PREVIOUS_MEMORY_SCHEMA_VERSION,
          targetVersion: MEMORY_TARGET_SCHEMA_VERSION,
          nextStep: 0,
          stepCount: 1,
          startedAt: 900,
          updatedAt: "damaged",
        },
        recovery: {
          active: true,
          lastProgressTick: 900,
          reason: "schema-migration",
          sinceTick: 900,
        },
      },
      config: {
        schemaVersion: 1,
        candidate: {
          revision: 12,
          overrides: { policy: { recovery: { protectedSpawnEnergy: 450 } } },
        },
        lastValid: null,
      },
      ...owners,
    },
  } as unknown as Memory;
}

function aggregateOverflowMemory(): Memory {
  const denseOwner = { values: Array.from({ length: 9_000 }, (_, index) => index) };
  const owners = Object.fromEntries(
    PERSISTENT_STATE_OWNERS.map((owner, index) => [owner, index < 6 ? denseOwner : {}]),
  );

  return {
    myrmex: {
      meta: {
        schemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
        targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
        revision: 4,
        firstTick: 920,
        lastTick: 950,
        shard: "shard3",
        diagnostics: [],
        migration: null,
        recovery: null,
      },
      ...owners,
    },
  } as unknown as Memory;
}
