import { describe, expect, it } from "vitest";
import { MAX_MIGRATION_STEP_BUDGET, openMyrmexMemory } from "../src/state/memory";
import { MEMORY_TARGET_SCHEMA_VERSION, PERSISTENT_STATE_OWNERS } from "../src/state/schema";

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
    for (let tick = 102; tick <= 105; tick += 1) {
      result = openMyrmexMemory(memory, tick, "shard3") as typeof started;
    }

    expect(result.status).toBe("ready");
    expect(memory.myrmex?.meta).toMatchObject({
      schemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      firstTick: 7,
      lastTick: 105,
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

  it("clamps requested work and cannot finish a legacy migration in one tick", () => {
    const memory = legacyMemory();
    const result = openMyrmexMemory(memory, 300, "shard1", {
      migrationStepBudget: Number.MAX_SAFE_INTEGER,
    });

    expect(MAX_MIGRATION_STEP_BUDGET).toBe(4);
    expect(result.status).toBe("recovery");
    expect(result.migrationStepsApplied).toBe(MAX_MIGRATION_STEP_BUDGET);
    expect(memory.myrmex?.meta.migration?.nextStep).toBe(3);

    expect(openMyrmexMemory(memory, 301, "shard1").status).toBe("ready");
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

  it("fails closed without downgrading a future schema", () => {
    const root = { meta: { schemaVersion: 99 } };
    const memory = { myrmex: root } as unknown as Memory;

    const result = openMyrmexMemory(memory, 500, "shard0");

    expect(result).toEqual({
      status: "unsupported",
      foundSchemaVersion: 99,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      migrationStepsApplied: 0,
    });
    expect(memory.myrmex).toBe(root);
  });

  it("preserves valid authority state while rebuilding a malformed optional subtree", () => {
    const memory = {} as Memory;
    const opened = openMyrmexMemory(memory, 600, "shard3");
    if (opened.status !== "ready") {
      throw new Error("expected current memory");
    }
    opened.manager.transaction("empire").replace({ objective: "survive", revision: 7 }).stage();
    expect(opened.manager.commitReconciliation()).toMatchObject({ committed: true });
    const root = memory.myrmex as unknown as Record<string, unknown>;
    root.telemetry = { invalid: undefined };

    expect(openMyrmexMemory(memory, 601, "shard3").status).toBe("recovery");
    for (let tick = 602; tick <= 605; tick += 1) {
      openMyrmexMemory(memory, tick, "shard3");
    }

    expect(memory.myrmex?.empire).toEqual({ objective: "survive", revision: 7 });
    expect(memory.myrmex?.telemetry).toEqual({});
    expect(memory.myrmex?.meta.firstTick).toBe(600);
    expect(memory.myrmex?.meta.diagnostics).toEqual([
      { code: "recovery-start", tick: 601, detail: "corrupt-root" },
      { code: "migration-complete", tick: 605, detail: "corrupt-root" },
    ]);
  });
});

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
