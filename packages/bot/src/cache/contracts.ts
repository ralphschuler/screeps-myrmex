export type CacheVersion = string | number | boolean;

export type DeterministicCacheKey =
  | null
  | boolean
  | number
  | string
  | readonly DeterministicCacheKey[]
  | { readonly [field: string]: DeterministicCacheKey };

export type CacheDependencyStamp = Readonly<Record<string, CacheVersion>>;

/**
 * Cache values cross a serialization boundary even though the cache lives on the heap.
 * This prevents cached Screeps objects and mutable references from becoming hidden state.
 */
export interface CacheCodec<Value> {
  readonly encode: (value: Value) => string;
  readonly decode: (encoded: string) => Value;
}

export interface CacheNamespaceContract<Key, Value> {
  readonly id: string;
  /** Canonical system that is allowed to register and invalidate this namespace. */
  readonly owner: string;
  readonly version: CacheVersion;
  readonly capacity: number;
  /** Hard bound for the canonical key representation. */
  readonly maxKeyLength: number;
  /** Hard bound for one encoded value, measured in JavaScript string code units. */
  readonly maxEncodedLength: number;
  /** Initial admission estimate for rebuilding one entry. */
  readonly estimatedRebuildCpu: number;
  /** `null` means the entry has no time-based expiry. */
  readonly ttlTicks: number | null;
  readonly keyOf: (key: Key) => DeterministicCacheKey;
  readonly codec: CacheCodec<Value>;
}

export interface CacheReadContext {
  readonly tick: number;
  /** The complete set of versions on which the computed value depends. */
  readonly dependencies?: CacheDependencyStamp;
}

export interface CacheWriteContext extends CacheReadContext {
  readonly ttlTicks?: number | null;
}

export type CacheLookup<Value> =
  { readonly hit: true; readonly value: Value } | { readonly hit: false };

export interface CacheNamespaceMetrics {
  readonly id: string;
  readonly owner: string;
  readonly entries: number;
  readonly capacity: number;
  readonly encodedLength: number;
  readonly maxEncodedLength: number;
  readonly estimatedRebuildCpu: number;
  readonly reads: number;
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  readonly computations: number;
  readonly buildCpu: number;
  readonly expirations: number;
  readonly invalidations: number;
  readonly evictions: number;
  readonly decodeFailures: number;
}

export interface CacheManagerMetrics {
  readonly namespaces: readonly CacheNamespaceMetrics[];
  readonly entries: number;
  readonly capacity: number;
}

export interface CacheManagerOptions {
  /** Injectable Screeps CPU meter. CacheManager never reads `Game` directly. */
  readonly cpuUsed?: () => number;
  /** Hard cap on registered namespaces in this heap instance. */
  readonly maximumNamespaces?: number;
}

export interface CacheSweepResult {
  readonly inspected: number;
  readonly removed: number;
  /** True when every entry in the requested scope has been visited since the sweep began. */
  readonly complete: boolean;
}

export interface CacheNamespace<Key, Value> {
  readonly id: string;
  readonly version: CacheVersion;
  get(key: Key, context: CacheReadContext): CacheLookup<Value>;
  set(key: Key, value: Value, context: CacheWriteContext): void;
  getOrCompute(key: Key, context: CacheWriteContext, compute: () => Value): Value;
  delete(key: Key): boolean;
  clear(): number;
  sweep(tick: number, maximumEntries: number): CacheSweepResult;
  metrics(): CacheNamespaceMetrics;
}
