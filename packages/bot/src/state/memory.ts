import { emptyWorldSnapshot } from "../world/snapshot";
import { MEMORY_SCHEMA_VERSION, type MyrmexMemory } from "./schema";

export function ensureMyrmexMemory(memory: Memory, gameTime: number, shard: string): MyrmexMemory {
  const existing = memory.myrmex;

  if (existing?.schema === MEMORY_SCHEMA_VERSION) {
    return existing;
  }

  const initialized: MyrmexMemory = {
    schema: MEMORY_SCHEMA_VERSION,
    boot: {
      firstTick: gameTime,
      lastTick: gameTime,
      shard,
    },
    world: emptyWorldSnapshot(gameTime),
    telemetry: {
      cpuUsed: 0,
      cpuBucket: 0,
      ownedRooms: 0,
    },
  };

  memory.myrmex = initialized;
  return initialized;
}
