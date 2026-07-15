import type {
  CacheDependencyStamp,
  CacheLookup,
  CacheManagerOptions,
  CacheManagerMetrics,
  CacheNamespace,
  CacheNamespaceContract,
  CacheNamespaceMetrics,
  CacheReadContext,
  CacheSweepResult,
  CacheVersion,
  CacheWriteContext,
} from "./contracts";
import { deterministicCacheKey } from "./deterministic-key";

interface CacheEntry {
  readonly encoded: string;
  readonly writtenAtTick: number;
  lastAccessTick: number;
  readonly expiresAtTick: number | null;
  readonly dependencyKey: string;
  readonly dependencies: CacheDependencyStamp;
}

interface MutableCounters {
  reads: number;
  hits: number;
  misses: number;
  writes: number;
  computations: number;
  buildCpu: number;
  expirations: number;
  invalidations: number;
  evictions: number;
  decodeFailures: number;
}

interface ManagedNamespace {
  readonly id: string;
  clear(): number;
  invalidateDependency(dependency: string, currentVersion?: CacheVersion): number;
  metrics(): CacheNamespaceMetrics;
  sweep(tick: number, maximumEntries: number): CacheSweepResult;
}

interface NormalizedDependencies {
  readonly key: string;
  readonly values: CacheDependencyStamp;
}

export class CacheManager {
  private readonly namespaces = new Map<string, ManagedNamespace>();
  private readonly cpuUsed: (() => number) | undefined;
  private readonly maximumNamespaces: number;
  private sweepNamespaceIndex = 0;

  constructor(options: CacheManagerOptions = {}) {
    this.maximumNamespaces = options.maximumNamespaces ?? 128;
    if (!Number.isSafeInteger(this.maximumNamespaces) || this.maximumNamespaces <= 0) {
      throw new RangeError("maximumNamespaces must be a positive safe integer");
    }
    this.cpuUsed = options.cpuUsed;
  }

  register<Key, Value>(contract: CacheNamespaceContract<Key, Value>): CacheNamespace<Key, Value> {
    const normalized = normalizeContract(contract);
    if (this.namespaces.has(normalized.id)) {
      throw new Error(`Cache namespace already registered: ${normalized.id}`);
    }
    if (this.namespaces.size >= this.maximumNamespaces) {
      throw new Error("Cache namespace registration capacity exceeded");
    }

    const namespace = new HeapCacheNamespace(normalized, this.cpuUsed);
    this.namespaces.set(normalized.id, namespace);
    return namespace;
  }

  registeredNamespaceIds(): readonly string[] {
    return Object.freeze([...this.namespaces.keys()].sort(compareStrings));
  }

  /** Clears every heap entry. Persistent state is deliberately not involved. */
  clear(): number {
    let cleared = 0;
    for (const namespace of this.sortedNamespaces()) {
      cleared += namespace.clear();
    }
    return cleared;
  }

  /**
   * Removes entries stamped with a dependency. If a current version is supplied,
   * entries already stamped with that exact version remain valid.
   */
  invalidateDependency(dependency: string, currentVersion?: CacheVersion): number {
    validateDependencyName(dependency);
    if (currentVersion !== undefined) {
      validateVersion(currentVersion, "dependency version");
    }

    let invalidated = 0;
    for (const namespace of this.sortedNamespaces()) {
      invalidated += namespace.invalidateDependency(dependency, currentVersion);
    }
    return invalidated;
  }

  metrics(): CacheManagerMetrics {
    const namespaces = this.sortedNamespaces().map((namespace) => namespace.metrics());
    return Object.freeze({
      namespaces: Object.freeze(namespaces),
      entries: namespaces.reduce((total, item) => total + item.entries, 0),
      capacity: namespaces.reduce((total, item) => total + item.capacity, 0),
    });
  }

  /** Performs at most `maximumEntries` expiry inspections across all namespaces. */
  sweep(tick: number, maximumEntries: number): CacheSweepResult {
    validateTick(tick);
    validateSweepLimit(maximumEntries);
    const namespaces = this.sortedNamespaces();
    if (namespaces.length === 0) {
      return Object.freeze({ inspected: 0, removed: 0, complete: true });
    }

    this.sweepNamespaceIndex %= namespaces.length;
    let inspected = 0;
    let removed = 0;
    let completedNamespaces = 0;
    while (inspected < maximumEntries && completedNamespaces < namespaces.length) {
      const namespace = namespaces[this.sweepNamespaceIndex];
      if (namespace === undefined) {
        break;
      }
      const result = namespace.sweep(tick, maximumEntries - inspected);
      inspected += result.inspected;
      removed += result.removed;
      if (!result.complete) {
        break;
      }
      completedNamespaces += 1;
      this.sweepNamespaceIndex = (this.sweepNamespaceIndex + 1) % namespaces.length;
    }
    return Object.freeze({
      inspected,
      removed,
      complete: completedNamespaces === namespaces.length,
    });
  }

  private sortedNamespaces(): readonly ManagedNamespace[] {
    return [...this.namespaces.values()].sort((left, right) => compareStrings(left.id, right.id));
  }
}

class HeapCacheNamespace<Key, Value> implements CacheNamespace<Key, Value>, ManagedNamespace {
  readonly id: string;
  readonly version: CacheVersion;

  private readonly entries = new Map<string, CacheEntry>();
  private encodedLength = 0;
  private sweepIterator: IterableIterator<[string, CacheEntry]> | null = null;
  private readonly counters: MutableCounters = {
    reads: 0,
    hits: 0,
    misses: 0,
    writes: 0,
    computations: 0,
    buildCpu: 0,
    expirations: 0,
    invalidations: 0,
    evictions: 0,
    decodeFailures: 0,
  };

  constructor(
    private readonly contract: CacheNamespaceContract<Key, Value>,
    private readonly cpuUsed: (() => number) | undefined,
  ) {
    this.id = contract.id;
    this.version = contract.version;
  }

  get(key: Key, context: CacheReadContext): CacheLookup<Value> {
    validateTick(context.tick);
    const normalizedKey = this.normalizeKey(key);
    const dependencies = normalizeDependencies(context.dependencies);
    this.counters.reads += 1;

    const entry = this.entries.get(normalizedKey);
    if (entry === undefined) {
      this.counters.misses += 1;
      return { hit: false };
    }

    if (entry.expiresAtTick !== null && context.tick >= entry.expiresAtTick) {
      this.removeEntry(normalizedKey);
      this.counters.expirations += 1;
      this.counters.misses += 1;
      return { hit: false };
    }

    if (entry.dependencyKey !== dependencies.key) {
      this.removeEntry(normalizedKey);
      this.counters.invalidations += 1;
      this.counters.misses += 1;
      return { hit: false };
    }

    try {
      const value = this.contract.codec.decode(entry.encoded);
      entry.lastAccessTick = context.tick;
      this.counters.hits += 1;
      return { hit: true, value };
    } catch {
      this.removeEntry(normalizedKey);
      this.counters.decodeFailures += 1;
      this.counters.invalidations += 1;
      this.counters.misses += 1;
      return { hit: false };
    }
  }

  set(key: Key, value: Value, context: CacheWriteContext): void {
    this.write(key, value, context);
  }

  getOrCompute(key: Key, context: CacheWriteContext, compute: () => Value): Value {
    const lookup = this.get(key, context);
    if (lookup.hit) {
      return lookup.value;
    }

    this.counters.computations += 1;
    const startedAt = this.cpuUsed?.();
    try {
      return this.write(key, compute(), context);
    } finally {
      if (startedAt !== undefined) {
        const finishedAt = this.cpuUsed?.();
        if (
          finishedAt !== undefined &&
          Number.isFinite(startedAt) &&
          Number.isFinite(finishedAt) &&
          finishedAt >= startedAt
        ) {
          this.counters.buildCpu += finishedAt - startedAt;
        }
      }
    }
  }

  private write(key: Key, value: Value, context: CacheWriteContext): Value {
    validateTick(context.tick);
    const ttlTicks = context.ttlTicks === undefined ? this.contract.ttlTicks : context.ttlTicks;
    validateTtl(ttlTicks);
    const normalizedKey = this.normalizeKey(key);
    const dependencies = normalizeDependencies(context.dependencies);
    const encoded = this.contract.codec.encode(value);
    if (typeof encoded !== "string") {
      throw new TypeError(`Cache codec for ${this.id} must return a string`);
    }
    if (encoded.length > this.contract.maxEncodedLength) {
      throw new RangeError(
        `Encoded cache value for ${this.id} exceeds ${String(
          this.contract.maxEncodedLength,
        )} code units`,
      );
    }
    const detached = this.contract.codec.decode(encoded);
    const roundTrip = this.contract.codec.encode(detached);
    if (roundTrip !== encoded) {
      throw new TypeError(`Cache codec for ${this.id} is not round-trip stable`);
    }
    const expiresAtTick = expiryTick(context.tick, ttlTicks);

    this.removeEntry(normalizedKey);
    this.entries.set(normalizedKey, {
      encoded,
      writtenAtTick: context.tick,
      lastAccessTick: context.tick,
      expiresAtTick,
      dependencyKey: dependencies.key,
      dependencies: dependencies.values,
    });
    this.encodedLength += encoded.length;
    this.counters.writes += 1;
    this.evictToCapacity(context.tick);
    return detached;
  }

  delete(key: Key): boolean {
    const deleted = this.removeEntry(this.normalizeKey(key));
    if (deleted) {
      this.counters.invalidations += 1;
    }
    return deleted;
  }

  clear(): number {
    const cleared = this.entries.size;
    this.entries.clear();
    this.encodedLength = 0;
    this.sweepIterator = null;
    this.counters.invalidations += cleared;
    return cleared;
  }

  invalidateDependency(dependency: string, currentVersion?: CacheVersion): number {
    let invalidated = 0;
    const keys = [...this.entries.keys()].sort(compareStrings);
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined || !(dependency in entry.dependencies)) {
        continue;
      }

      if (
        currentVersion !== undefined &&
        Object.is(entry.dependencies[dependency], currentVersion)
      ) {
        continue;
      }

      this.removeEntry(key);
      invalidated += 1;
    }
    this.counters.invalidations += invalidated;
    return invalidated;
  }

  metrics(): CacheNamespaceMetrics {
    return Object.freeze({
      id: this.id,
      owner: this.contract.owner,
      entries: this.entries.size,
      capacity: this.contract.capacity,
      encodedLength: this.encodedLength,
      maxEncodedLength: this.contract.maxEncodedLength,
      estimatedRebuildCpu: this.contract.estimatedRebuildCpu,
      ...this.counters,
    });
  }

  private normalizeKey(key: Key): string {
    const normalized = deterministicCacheKey(this.contract.keyOf(key));
    if (normalized.length > this.contract.maxKeyLength) {
      throw new RangeError(
        `Cache key for ${this.id} exceeds ${String(this.contract.maxKeyLength)} code units`,
      );
    }
    return normalized;
  }

  sweep(tick: number, maximumEntries: number): CacheSweepResult {
    validateTick(tick);
    validateSweepLimit(maximumEntries);
    this.sweepIterator ??= this.entries.entries();
    let inspected = 0;
    let removed = 0;
    while (inspected < maximumEntries) {
      const next = this.sweepIterator.next();
      if (next.done) {
        this.sweepIterator = null;
        return Object.freeze({ inspected, removed, complete: true });
      }
      inspected += 1;
      const [key, entry] = next.value;
      if (entry.expiresAtTick !== null && tick >= entry.expiresAtTick) {
        this.removeEntry(key);
        this.counters.expirations += 1;
        removed += 1;
      }
    }
    return Object.freeze({ inspected, removed, complete: false });
  }

  private evictToCapacity(tick: number): void {
    while (this.entries.size > this.contract.capacity) {
      const victim = [...this.entries.entries()].sort((left, right) =>
        compareEntries(left, right, tick),
      )[0];
      if (victim === undefined) {
        return;
      }
      this.removeEntry(victim[0]);
      this.counters.evictions += 1;
    }
  }

  private removeEntry(key: string): boolean {
    const existing = this.entries.get(key);
    if (existing === undefined || !this.entries.delete(key)) {
      return false;
    }
    this.encodedLength -= existing.encoded.length;
    return true;
  }
}

function normalizeContract<Key, Value>(
  contract: CacheNamespaceContract<Key, Value>,
): CacheNamespaceContract<Key, Value> {
  validateContract(contract);
  const keyOf = contract.keyOf.bind(contract);
  const encode = contract.codec.encode.bind(contract.codec);
  const decode = contract.codec.decode.bind(contract.codec);
  return Object.freeze({
    id: contract.id,
    owner: contract.owner,
    version: contract.version,
    capacity: contract.capacity,
    maxKeyLength: contract.maxKeyLength,
    maxEncodedLength: contract.maxEncodedLength,
    estimatedRebuildCpu: contract.estimatedRebuildCpu,
    ttlTicks: contract.ttlTicks,
    keyOf: (key: Key) => keyOf(key),
    codec: Object.freeze({
      encode: (value: Value) => encode(value),
      decode: (encoded: string) => decode(encoded),
    }),
  });
}

function validateContract<Key, Value>(contract: CacheNamespaceContract<Key, Value>): void {
  if (contract.id.length === 0 || contract.id !== contract.id.trim() || contract.id.length > 128) {
    throw new TypeError(
      "Cache namespace id must be a non-empty, trimmed string of at most 128 characters",
    );
  }
  if (!Number.isSafeInteger(contract.capacity) || contract.capacity <= 0) {
    throw new RangeError("Cache namespace capacity must be a positive integer");
  }
  if (contract.capacity > 10_000) {
    throw new RangeError("Cache namespace capacity must not exceed 10000 entries");
  }
  if (
    contract.owner.length === 0 ||
    contract.owner !== contract.owner.trim() ||
    contract.owner.length > 128
  ) {
    throw new TypeError(
      "Cache namespace owner must be a non-empty, trimmed string of at most 128 characters",
    );
  }
  if (!Number.isSafeInteger(contract.maxEncodedLength) || contract.maxEncodedLength <= 0) {
    throw new RangeError("Cache namespace maxEncodedLength must be a positive integer");
  }
  if (!Number.isSafeInteger(contract.maxKeyLength) || contract.maxKeyLength <= 0) {
    throw new RangeError("Cache namespace maxKeyLength must be a positive integer");
  }
  if (contract.maxKeyLength > 16_384 || contract.maxEncodedLength > 1_000_000) {
    throw new RangeError("Cache namespace key or value bound exceeds the global safety limit");
  }
  if (!Number.isFinite(contract.estimatedRebuildCpu) || contract.estimatedRebuildCpu < 0) {
    throw new RangeError("Cache namespace estimatedRebuildCpu must be a non-negative number");
  }
  validateTtl(contract.ttlTicks);
  validateVersion(contract.version, "cache namespace version");
  if (
    typeof contract.keyOf !== "function" ||
    typeof contract.codec.encode !== "function" ||
    typeof contract.codec.decode !== "function"
  ) {
    throw new TypeError("Cache namespace key and codec functions are required");
  }
}

function validateTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError("Cache tick must be a non-negative safe integer");
  }
}

function validateTtl(ttlTicks: number | null): void {
  if (ttlTicks !== null && (!Number.isSafeInteger(ttlTicks) || ttlTicks <= 0)) {
    throw new RangeError("Cache TTL must be a positive integer or null");
  }
}

function validateVersion(version: CacheVersion, label: string): void {
  if (typeof version === "number" && !Number.isFinite(version)) {
    throw new TypeError(`${label} must be finite`);
  }
}

function validateDependencyName(dependency: string): void {
  if (dependency.length === 0 || dependency !== dependency.trim()) {
    throw new TypeError("Cache dependency names must be non-empty and trimmed");
  }
}

function validateSweepLimit(maximumEntries: number): void {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new RangeError("Cache sweep maximumEntries must be a positive safe integer");
  }
}

function normalizeDependencies(
  dependencies: CacheDependencyStamp | undefined,
): NormalizedDependencies {
  const values: Record<string, CacheVersion> = Object.create(null) as Record<string, CacheVersion>;
  for (const dependency of Object.keys(dependencies ?? {}).sort(compareStrings)) {
    validateDependencyName(dependency);
    const version = dependencies?.[dependency];
    if (version === undefined) {
      throw new TypeError(`Missing version for cache dependency: ${dependency}`);
    }
    validateVersion(version, `version for cache dependency ${dependency}`);
    values[dependency] = version;
  }

  const frozen = Object.freeze(values);
  return {
    key: deterministicCacheKey(frozen),
    values: frozen,
  };
}

function expiryTick(tick: number, ttlTicks: number | null): number | null {
  if (ttlTicks === null) {
    return null;
  }
  if (tick > Number.MAX_SAFE_INTEGER - ttlTicks) {
    throw new RangeError("Cache expiry tick exceeds the safe integer range");
  }
  return tick + ttlTicks;
}

function compareEntries(
  [leftKey, left]: readonly [string, CacheEntry],
  [rightKey, right]: readonly [string, CacheEntry],
  tick: number,
): number {
  const leftExpired = left.expiresAtTick !== null && tick >= left.expiresAtTick;
  const rightExpired = right.expiresAtTick !== null && tick >= right.expiresAtTick;
  if (leftExpired !== rightExpired) {
    return leftExpired ? -1 : 1;
  }
  if (left.lastAccessTick !== right.lastAccessTick) {
    return left.lastAccessTick - right.lastAccessTick;
  }
  if (left.writtenAtTick !== right.writtenAtTick) {
    return left.writtenAtTick - right.writtenAtTick;
  }
  return compareStrings(leftKey, rightKey);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
