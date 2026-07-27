import type { CacheManager, CacheNamespace } from "../../cache";
import type { RoutePlanV1 } from "./contracts";

export type RoutePlanCacheKey = readonly [
  requestId: string,
  originRoomName: string,
  destinationRoomName: string,
  policyRevision: string,
  bodyRevision: string,
  budgetRevision: string,
];

export interface RoutePlanCache {
  readonly plans: CacheNamespace<RoutePlanCacheKey, RoutePlanV1>;
}

const caches = new WeakMap<CacheManager, RoutePlanCache>();

/** Registers the sole bounded reconstructible room-route cache for one heap CacheManager. */
export function getRoutePlanCache(manager: CacheManager): RoutePlanCache {
  const existing = caches.get(manager);
  if (existing !== undefined) return existing;
  const plans = manager.register<RoutePlanCacheKey, RoutePlanV1>({
    id: "world.route-plan.v1",
    owner: "RoutePlanner",
    version: 1,
    capacity: 64,
    maxKeyLength: 1_024,
    maxEncodedLength: 8_192,
    estimatedRebuildCpu: 0.25,
    ttlTicks: 25,
    keyOf: (key) => key,
    codec: {
      encode: (value) => JSON.stringify(value),
      decode: (encoded) => JSON.parse(encoded) as RoutePlanV1,
    },
  });
  const created = Object.freeze({ plans });
  caches.set(manager, created);
  return created;
}
