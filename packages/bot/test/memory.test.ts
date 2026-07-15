import { describe, expect, it } from "vitest";
import { openMyrmexMemory } from "../src/state/memory";
import {
  MEMORY_CURRENT_SCHEMA_VERSION,
  MEMORY_TARGET_SCHEMA_VERSION,
  PERSISTENT_STATE_OWNERS,
} from "../src/state/schema";

describe("MYRMEX memory", () => {
  it("cold-boots the current durable schema without persisting a tick world", () => {
    const memory = {} as Memory;
    const opened = openMyrmexMemory(memory, 100, "shard3");

    expect(opened.status).toBe("ready");
    expect(memory.myrmex?.meta).toMatchObject({
      schemaVersion: MEMORY_CURRENT_SCHEMA_VERSION,
      targetSchemaVersion: MEMORY_TARGET_SCHEMA_VERSION,
      firstTick: 100,
      lastTick: 100,
      shard: "shard3",
      migration: null,
      recovery: null,
    });
    expect(Object.keys(memory.myrmex ?? {}).sort()).toEqual(
      ["meta", ...PERSISTENT_STATE_OWNERS].sort(),
    );
    expect(memory.myrmex?.config).toEqual({});
    expect(JSON.stringify(memory.myrmex)).not.toContain('"world"');
  });
});
