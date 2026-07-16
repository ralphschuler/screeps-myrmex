import type { CacheDependencyStamp, CacheManager, CacheNamespace } from "../cache";
import type { LayoutPlacement } from "./contracts";
export const LAYOUT_COMPILED_CACHE_ID = "layout.compiled.v1" as const;
export interface LayoutCacheKey {
  readonly roomName: string;
  readonly fingerprint: string;
}
export interface LayoutCacheDependencies {
  readonly algorithmRevision: string;
  readonly factsRevision: string;
  readonly policyRevision: string;
  readonly terrainRevision: string;
}
export function layoutCacheDependencies(value: LayoutCacheDependencies): CacheDependencyStamp {
  return Object.freeze({
    algorithmRevision: value.algorithmRevision,
    factsRevision: value.factsRevision,
    policyRevision: value.policyRevision,
    terrainRevision: value.terrainRevision,
  });
}
export function registerLayoutCompiledCache(
  manager: CacheManager,
): CacheNamespace<LayoutCacheKey, readonly LayoutPlacement[]> {
  return manager.register({
    id: LAYOUT_COMPILED_CACHE_ID,
    owner: "LayoutPlanner",
    version: 1,
    capacity: 64,
    maxKeyLength: 256,
    maxEncodedLength: 65_536,
    estimatedRebuildCpu: 2,
    ttlTicks: null,
    keyOf: (key) => ({ fingerprint: key.fingerprint, roomName: key.roomName }),
    codec: {
      encode: JSON.stringify,
      decode: (encoded) => JSON.parse(encoded) as readonly LayoutPlacement[],
    },
  });
}
