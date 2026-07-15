import { describe, expect, it } from "vitest";
import { ensureMyrmexMemory } from "../src/state/memory";

describe("MYRMEX memory", () => {
  it("initializes the versioned schema and preserves it on later ticks", () => {
    const memory = {} as Memory;

    const first = ensureMyrmexMemory(memory, 100, "shard3");
    const second = ensureMyrmexMemory(memory, 101, "shard3");

    expect(first).toBe(second);
    expect(first).toMatchObject({
      schema: 1,
      boot: { firstTick: 100, lastTick: 100, shard: "shard3" },
    });
  });
});
