import { describe, expect, it } from "vitest";
import {
  MAX_CREEP_MEMORY_ENTRIES_INSPECTED_PER_TICK,
  MAX_STALE_CREEP_MEMORY_DELETIONS_PER_TICK,
  cleanStaleCreepMemory,
} from "../src/runtime/platform-memory-hygiene";

describe("platform memory hygiene", () => {
  it("removes stale creep memory while preserving live entries and MYRMEX state exactly", () => {
    const liveValue = { role: "legacy", nested: { untouched: true } };
    const myrmex = { marker: "owned-elsewhere" };
    const memory = {
      creeps: {
        dead: { stale: true },
        live: liveValue,
      },
      myrmex,
    } as unknown as Memory;

    expect(cleanStaleCreepMemory(memory, { live: {} }, 0)).toEqual({
      inspected: 2,
      removed: 1,
    });
    expect((memory as unknown as { creeps: Record<string, unknown> }).creeps).toEqual({
      live: liveValue,
    });
    expect((memory as unknown as { myrmex: unknown }).myrmex).toBe(myrmex);
    expect((memory as unknown as { creeps: Record<string, unknown> }).creeps.live).toBe(liveValue);
  });

  it("does not create or coerce a missing or malformed creep-memory table", () => {
    const missing = {} as Memory;
    const malformed = { creeps: [] } as unknown as Memory;

    expect(cleanStaleCreepMemory(missing, {}, 1)).toEqual({ inspected: 0, removed: 0 });
    expect(cleanStaleCreepMemory(malformed, {}, 1)).toEqual({ inspected: 0, removed: 0 });
    expect(missing).not.toHaveProperty("creeps");
    expect((malformed as unknown as { creeps: unknown }).creeps).toEqual([]);
  });

  it("bounds each pass and deterministically converges across canonical windows", () => {
    const creepMemory = Object.fromEntries(
      Array.from({ length: 260 }, (_, index) => [
        `dead-${String(index).padStart(3, "0")}`,
        { index },
      ]),
    );
    const memory = { creeps: creepMemory } as unknown as Memory;
    let maximumInspected = 0;
    let maximumRemoved = 0;

    for (let tick = 0; tick < 20 && Object.keys(creepMemory).length > 0; tick += 1) {
      const result = cleanStaleCreepMemory(memory, {}, tick);
      maximumInspected = Math.max(maximumInspected, result.inspected);
      maximumRemoved = Math.max(maximumRemoved, result.removed);
    }

    expect(maximumInspected).toBeLessThanOrEqual(MAX_CREEP_MEMORY_ENTRIES_INSPECTED_PER_TICK);
    expect(maximumRemoved).toBeLessThanOrEqual(MAX_STALE_CREEP_MEMORY_DELETIONS_PER_TICK);
    expect(creepMemory).toEqual({});
  });

  it("uses the tick window without deleting a live entry under reordered input", () => {
    const live = { exact: "bytes" };
    const creepMemory: Record<string, { readonly exact?: string }> = {
      "stale-z": {},
      live,
      "stale-a": {},
    };
    const memory = { creeps: creepMemory } as unknown as Memory;

    cleanStaleCreepMemory(memory, { live: {}, other: {} }, 37);

    expect(creepMemory).toEqual({ live });
    expect(creepMemory.live).toBe(live);
  });
});
