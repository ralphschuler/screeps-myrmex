import { describe, expect, it } from "vitest";
import { openMyrmexMemory } from "../src/state/memory";
import { validateJsonValue } from "../src/state/validation";

describe("MemoryManager transactions", () => {
  it("keeps writes staged until one reconciliation commit", () => {
    const memory = {} as Memory;
    const manager = readyManager(memory, 10);
    const before = memory.myrmex;

    const transaction = manager.transaction("kernel");
    transaction.mutate((draft) => {
      draft.health = { failures: 0, mode: "normal" };
    });
    expect(transaction.stage()).toEqual({ staged: true });
    expect(memory.myrmex).toBe(before);
    expect(memory.myrmex?.kernel).toEqual({});

    expect(manager.commitReconciliation()).toEqual({
      committed: true,
      owners: ["kernel"],
      revision: 1,
    });
    expect(memory.myrmex).not.toBe(before);
    expect(memory.myrmex?.kernel).toEqual({
      health: { failures: 0, mode: "normal" },
    });
    expect(memory.myrmex?.meta.lastTick).toBe(10);
  });

  it("provides frozen detached views and isolated transaction drafts", () => {
    const memory = {} as Memory;
    const manager = readyManager(memory, 20);
    const view = manager.ownerView("empire");

    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      (view as Record<string, unknown>).policy = "hostile";
    }).toThrow(TypeError);
    expect(memory.myrmex?.empire).toEqual({});

    const transaction = manager.transaction("empire");
    transaction.mutate((draft) => {
      draft.policy = { revision: 1 };
    });
    expect(memory.myrmex?.empire).toEqual({});
    transaction.discard();
    expect(manager.commitReconciliation()).toMatchObject({ committed: true, owners: [] });
    expect(memory.myrmex?.empire).toEqual({});
  });

  it("keeps raw operator config out of the aggregate state view", () => {
    const memory = {} as Memory;
    const manager = readyManager(memory, 25);
    manager
      .transaction("config")
      .replace({ candidate: { revision: 1, overrides: { survival: { reserve: 8_000 } } } })
      .stage();

    expect(manager.commitReconciliation()).toMatchObject({ committed: true, owners: ["config"] });
    expect(memory.myrmex?.config).toEqual({
      candidate: { revision: 1, overrides: { survival: { reserve: 8_000 } } },
    });
    expect(manager.view()).not.toHaveProperty("config");
  });

  it("atomically rejects every staged owner when one owner is not JSON-safe", () => {
    const memory = {} as Memory;
    const manager = readyManager(memory, 30);
    const before = memory.myrmex;

    expect(manager.transaction("empire").replace({ objective: "survive" }).stage()).toEqual({
      staged: true,
    });
    const invalid = manager.transaction("kernel").replace({ estimate: Number.NaN }).stage();
    expect(invalid).toMatchObject({
      staged: false,
      fault: { code: "invalid-owner-state", owner: "kernel", path: "$.estimate" },
    });

    const commit = manager.commitReconciliation();
    expect(commit).toMatchObject({
      committed: false,
      faults: [{ code: "invalid-owner-state", owner: "kernel" }],
    });
    expect(memory.myrmex).toBe(before);
    expect(memory.myrmex?.empire).toEqual({});
  });

  it("rejects open transactions and stale direct root replacement", () => {
    const memory = {} as Memory;
    const manager = readyManager(memory, 40);
    manager.transaction("contracts");

    expect(manager.commitReconciliation()).toMatchObject({
      committed: false,
      faults: [{ code: "open-transaction", owner: "contracts" }],
    });

    const nextManager = readyManager(memory, 41);
    memory.myrmex = JSON.parse(JSON.stringify(memory.myrmex)) as NonNullable<typeof memory.myrmex>;
    expect(nextManager.commitReconciliation()).toMatchObject({
      committed: false,
      faults: [{ code: "stale-root" }],
    });
  });

  it("detects non-JSON values, sparse arrays, class instances, and cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array(2) as unknown[];
    sparse[1] = "value";

    expect(validateJsonValue({ missing: undefined })).toMatchObject({ valid: false });
    expect(validateJsonValue({ callback: () => undefined })).toMatchObject({ valid: false });
    expect(validateJsonValue({ invalidNumber: Number.POSITIVE_INFINITY })).toMatchObject({
      valid: false,
    });
    expect(validateJsonValue({ when: new Date(0) })).toMatchObject({ valid: false });
    expect(validateJsonValue({ sparse })).toMatchObject({ valid: false });
    expect(validateJsonValue(cyclic)).toMatchObject({ valid: false });
    expect(validateJsonValue({ safe: [null, true, 1, "value", { nested: [] }] })).toEqual({
      valid: true,
    });
  });

  it("produces a root that can be JSON stringified and parsed after valid commits", () => {
    const memory = {} as Memory;
    const manager = readyManager(memory, 50);
    manager
      .transaction("operations")
      .replace({ active: [{ id: "defend:W1N1", state: "authorized", tick: 50 }] })
      .stage();

    expect(manager.commitReconciliation()).toMatchObject({ committed: true });
    const roundTrip = JSON.parse(JSON.stringify(memory.myrmex)) as unknown;
    expect(roundTrip).toEqual(memory.myrmex);
    expect(roundTrip).not.toHaveProperty("world");
  });
});

function readyManager(memory: Memory, tick: number) {
  const result = openMyrmexMemory(memory, tick, "shard3");
  if (result.status !== "ready") {
    throw new Error(`expected ready memory, got ${result.status}`);
  }
  return result.manager;
}
