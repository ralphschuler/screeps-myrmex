import type { WorldSnapshot } from "../world/snapshot";

export const MEMORY_SCHEMA_VERSION = 1 as const;

export interface MyrmexMemory {
  readonly schema: typeof MEMORY_SCHEMA_VERSION;
  readonly boot: {
    readonly firstTick: number;
    lastTick: number;
    readonly shard: string;
  };
  world: WorldSnapshot;
  telemetry: {
    cpuUsed: number;
    cpuBucket: number;
    ownedRooms: number;
  };
}

declare global {
  interface Memory {
    myrmex?: MyrmexMemory;
  }
}
