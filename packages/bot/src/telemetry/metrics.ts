import type { CacheManagerMetrics } from "../cache";
import type { WorldSnapshot } from "../world/snapshot";

export interface TickTelemetry {
  readonly tick: number;
  readonly shard: string;
  readonly memoryStatus: "ready" | "recovery" | "unsupported";
  readonly cpuBucket: number;
  readonly ownedRooms: number;
  readonly snapshotBytes: number;
  readonly cacheEntries: number;
  readonly cacheNamespaces: number;
}

export interface TickTelemetryInput {
  readonly tick: number;
  readonly shard: string;
  readonly memoryStatus: TickTelemetry["memoryStatus"];
  readonly cpuBucket: number;
  readonly snapshot: WorldSnapshot;
  readonly cache: CacheManagerMetrics;
}

/** Creates a bounded, immutable per-tick summary; durable history is a later telemetry policy. */
export function recordTickTelemetry(input: TickTelemetryInput): TickTelemetry {
  return Object.freeze({
    tick: input.tick,
    shard: input.shard,
    memoryStatus: input.memoryStatus,
    cpuBucket: input.cpuBucket,
    ownedRooms: input.snapshot.ownedRooms.length,
    snapshotBytes: input.snapshot.stats.estimatedPayloadBytes,
    cacheEntries: input.cache.entries,
    cacheNamespaces: input.cache.namespaces.length,
  });
}
