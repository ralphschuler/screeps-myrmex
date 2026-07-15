import { CacheManager } from "./cache-manager";

let runtimeCache: CacheManager | null = null;

/**
 * Returns the sole reconstructible heap cache authority for this global. Screeps global resets
 * naturally recreate this module and therefore the manager; correctness may never depend on it.
 */
export function getRuntimeCacheManager(): CacheManager {
  runtimeCache ??= new CacheManager();
  return runtimeCache;
}
