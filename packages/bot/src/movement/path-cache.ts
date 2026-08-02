import {
  createJsonCacheCodec,
  type CacheManager,
  type CacheNamespace,
  type CacheWriteContext,
  type JsonValue,
} from "../cache";
import type { MovementPolicy } from "../config";
import type { PositionSnapshot, WorldSnapshot } from "../world/snapshot";

export interface StaticTraversalMatrix {
  readonly [field: string]: JsonValue;
  readonly roomName: string;
  readonly revision: string;
  /** 2,500 cells in y-major order: `.` is walkable and `#` is a static blocker. */
  readonly walkability: string;
}

export interface LocalPath {
  readonly [field: string]: JsonValue;
  readonly cost: number;
  readonly directions: readonly number[];
  readonly roomName: string;
}

export interface MovementPathCache {
  readonly localPaths: CacheNamespace<readonly [string, string], LocalPath>;
  readonly staticMatrices: CacheNamespace<readonly [string, string], StaticTraversalMatrix>;
}

/** Narrow adapter for the engine path search; callers cannot hand a live Game object to planning. */
export interface LocalPathSearch {
  search(input: LocalPathSearchInput): LocalPathSearchOutput;
}

export interface LocalPathSearchInput {
  /** Canonical tick-local blockers overlaid after the reusable static matrix is reconstructed. */
  readonly blockedPositions: readonly PositionSnapshot[];
  readonly goal: PositionSnapshot;
  readonly maxCost: number;
  readonly maxOps: number;
  readonly origin: PositionSnapshot;
  readonly range: number;
  readonly staticMatrix: StaticTraversalMatrix;
}

export interface LocalPathSearchOutput {
  readonly cost: number;
  readonly directions: readonly DirectionConstant[];
  readonly incomplete: boolean;
}

export interface LocalPathPlanRequest {
  /** CPU remaining in the system's CpuScheduler admission budget. */
  readonly availableCpu: number;
  /** Tick-local occupancy/reservations. These never enter a reusable cache value or key. */
  readonly blockedPositions?: readonly PositionSnapshot[];
  /** Force one bounded cold search even when no dynamic blocker remains visible. */
  readonly bypassCache?: boolean;
  readonly buildStaticMatrix: () => StaticTraversalMatrix;
  readonly estimatedSearchCpu: number;
  readonly goal: PositionSnapshot;
  readonly origin: PositionSnapshot;
  readonly range: number;
  readonly staticMatrixRevision: string;
  readonly tick: number;
}

export type LocalPathPlanResult =
  | {
      readonly cost: number;
      readonly directions: readonly DirectionConstant[];
      readonly source: "cache" | "search";
      readonly status: "ready";
    }
  | { readonly reason: "cpu-budget"; readonly status: "deferred" }
  | {
      readonly reason: "adapter-fault" | "incomplete" | "invalid" | "unavailable";
      readonly status: "no-path";
    };

export interface LocalPathPlanningRequest {
  /** The CpuScheduler admission budget of the currently running planning system. */
  readonly availableCpu: number;
  /** Tick-local occupancy/reservations. These never enter a reusable cache value or key. */
  readonly blockedPositions?: readonly PositionSnapshot[];
  readonly bypassCache?: boolean;
  readonly goal: PositionSnapshot;
  readonly origin: PositionSnapshot;
  readonly range: number;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}

export interface LocalPathPlanningService {
  plan(request: LocalPathPlanningRequest): LocalPathPlanResult;
}

export const LOCAL_PATH_SEARCH_CPU_ESTIMATE = 0.5;
export const MAX_DYNAMIC_MOVEMENT_BLOCKERS = 128;

/**
 * Canonical data-only service for plan systems. It extracts an observed static traversal projection
 * from the immutable world snapshot; no planner can supply a live terrain, room, or PathFinder.
 */
export class SnapshotLocalPathPlanningService implements LocalPathPlanningService {
  private readonly planner: LocalPathPlanner | null;

  public constructor(
    cache: MovementPathCache,
    search: LocalPathSearch | null,
    policy: MovementPolicy,
  ) {
    this.planner = search === null ? null : new LocalPathPlanner(cache, search, policy);
  }

  public plan(request: LocalPathPlanningRequest): LocalPathPlanResult {
    if (this.planner === null) return Object.freeze({ reason: "unavailable", status: "no-path" });
    const room = request.snapshot.rooms.find(({ name }) => name === request.origin.roomName);
    const traversal = room?.traversal;
    if (
      room === undefined ||
      traversal === undefined ||
      request.goal.roomName !== request.origin.roomName ||
      !isValidWalkability(traversal.walkability)
    )
      return Object.freeze({ reason: "invalid", status: "no-path" });
    return this.planner.plan({
      availableCpu: request.availableCpu,
      blockedPositions: request.blockedPositions ?? [],
      bypassCache: request.bypassCache ?? false,
      buildStaticMatrix: () => ({
        roomName: room.name,
        revision: traversal.revision,
        walkability: traversal.walkability,
      }),
      estimatedSearchCpu: LOCAL_PATH_SEARCH_CPU_ESTIMATE,
      goal: request.goal,
      origin: request.origin,
      range: request.range,
      staticMatrixRevision: traversal.revision,
      tick: request.tick,
    });
  }
}

/**
 * Bounded local-room path admission. The surrounding tick system receives its budget from
 * CpuScheduler; this service refuses a cold search that would overrun that budget. Dynamic
 * creep occupancy and reservations intentionally remain outside the cached static path.
 */
export class LocalPathPlanner {
  public constructor(
    private readonly cache: MovementPathCache,
    private readonly search: LocalPathSearch,
    private readonly policy: MovementPolicy,
  ) {}

  public plan(request: LocalPathPlanRequest): LocalPathPlanResult {
    if (!isValidRequest(request)) return Object.freeze({ reason: "invalid", status: "no-path" });
    try {
      const blockedPositions = canonicalBlockedPositions(
        request.blockedPositions ?? [],
        request.origin,
      );
      if (blockedPositions === null) return Object.freeze({ reason: "invalid", status: "no-path" });
      const bypassCache = request.bypassCache === true || blockedPositions.length > 0;
      const pathKey = [
        request.origin.roomName,
        `${request.staticMatrixRevision}:${positionKey(request.origin)}:${positionKey(request.goal)}:${String(request.range)}:${String(this.policy.maximumSearchOperations)}:${String(this.policy.maximumPathCost)}`,
      ] as const;
      if (!bypassCache) {
        const cached = this.cache.localPaths.get(pathKey, {
          dependencies: { staticMatrixRevision: request.staticMatrixRevision },
          tick: request.tick,
        });
        if (cached.hit && isValidLocalPath(cached.value, request.origin.roomName))
          return Object.freeze({
            cost: cached.value.cost,
            directions: Object.freeze([...cached.value.directions]) as readonly DirectionConstant[],
            source: "cache",
            status: "ready",
          });
      }
      if (request.estimatedSearchCpu > request.availableCpu)
        return Object.freeze({ reason: "cpu-budget", status: "deferred" });

      const staticKey = [request.origin.roomName, request.staticMatrixRevision] as const;
      const staticMatrix = this.cache.staticMatrices.getOrCompute(
        staticKey,
        {
          dependencies: { staticMatrixRevision: request.staticMatrixRevision },
          tick: request.tick,
        },
        request.buildStaticMatrix,
      );
      if (!isValidStaticMatrix(staticMatrix, request.origin.roomName, request.staticMatrixRevision))
        return Object.freeze({ reason: "invalid", status: "no-path" });

      const result = this.search.search({
        blockedPositions,
        goal: request.goal,
        maxCost: this.policy.maximumPathCost,
        maxOps: this.policy.maximumSearchOperations,
        origin: request.origin,
        range: request.range,
        staticMatrix,
      });
      if (
        result.incomplete ||
        !Number.isSafeInteger(result.cost) ||
        result.cost <= 0 ||
        result.cost > this.policy.maximumPathCost ||
        result.directions.length === 0 ||
        !result.directions.every(isDirection)
      )
        return Object.freeze({ reason: "incomplete", status: "no-path" });

      const directions = Object.freeze([...result.directions]);
      const path: LocalPath = Object.freeze({
        cost: result.cost,
        directions,
        roomName: request.origin.roomName,
      });
      if (!bypassCache)
        this.cache.localPaths.set(pathKey, path, {
          dependencies: { staticMatrixRevision: request.staticMatrixRevision },
          tick: request.tick,
        });
      return Object.freeze({ cost: result.cost, directions, source: "search", status: "ready" });
    } catch {
      return Object.freeze({ reason: "adapter-fault", status: "no-path" });
    }
  }
}

const caches = new WeakMap<CacheManager, MovementPathCache>();

type MovementPathCacheKey = readonly ["local" | "static", string, string];
type MovementPathCacheEntry =
  | {
      readonly [field: string]: JsonValue;
      readonly kind: "local";
      readonly value: LocalPath;
    }
  | {
      readonly [field: string]: JsonValue;
      readonly kind: "static";
      readonly value: StaticTraversalMatrix;
    };

/**
 * Registers one bounded, reconstructible path namespace once per heap CacheManager. Tagged keys
 * preserve the independent local-path/static-matrix TTL and dependency contracts without spending
 * a second namespace. Dynamic occupancy, reservations, and live game objects remain absent.
 */
export function getMovementPathCache(manager: CacheManager): MovementPathCache {
  const existing = caches.get(manager);
  if (existing !== undefined) return existing;
  const namespace = manager.register<MovementPathCacheKey, MovementPathCacheEntry>({
    id: "movement.path-cache.v3",
    owner: "movement.path-cache",
    version: 3,
    // Leaves exact headroom for the 128-record progress cache and one compiled layout under the
    // frozen 384-entry production bound.
    capacity: 240,
    maxKeyLength: 544,
    maxEncodedLength: 12_256,
    estimatedRebuildCpu: 0.5,
    ttlTicks: null,
    keyOf: (key) => key,
    codec: createJsonCacheCodec<MovementPathCacheEntry>(),
  });
  const staticMatrices = movementPathNamespaceView<StaticTraversalMatrix>(
    namespace,
    "static",
    null,
  );
  const localPaths = movementPathNamespaceView<LocalPath>(namespace, "local", 25);
  const created = Object.freeze({ localPaths, staticMatrices });
  caches.set(manager, created);
  return created;
}

function movementPathNamespaceView<Value extends LocalPath | StaticTraversalMatrix>(
  namespace: CacheNamespace<MovementPathCacheKey, MovementPathCacheEntry>,
  kind: MovementPathCacheEntry["kind"],
  ttlTicks: number | null,
): CacheNamespace<readonly [string, string], Value> {
  const cacheKey = (key: readonly [string, string]): MovementPathCacheKey => [kind, key[0], key[1]];
  const entry = (value: Value): MovementPathCacheEntry =>
    ({ kind, value }) as MovementPathCacheEntry;
  const value = (candidate: MovementPathCacheEntry): Value => {
    if (candidate.kind !== kind) throw new TypeError("movement path cache kind mismatch");
    return candidate.value as Value;
  };
  const context = (candidate: CacheWriteContext): CacheWriteContext =>
    candidate.ttlTicks === undefined ? { ...candidate, ttlTicks } : candidate;
  const view: CacheNamespace<readonly [string, string], Value> = {
    id: namespace.id,
    version: namespace.version,
    get(key, readContext) {
      const found = namespace.get(cacheKey(key), readContext);
      return found.hit ? Object.freeze({ hit: true, value: value(found.value) }) : found;
    },
    set(key, nextValue, writeContext) {
      namespace.set(cacheKey(key), entry(nextValue), context(writeContext));
    },
    getOrCompute(key, writeContext, compute) {
      return value(
        namespace.getOrCompute(cacheKey(key), context(writeContext), () => entry(compute())),
      );
    },
    delete(key) {
      return namespace.delete(cacheKey(key));
    },
    clear() {
      return namespace.clear();
    },
    sweep(tick, maximumEntries) {
      return namespace.sweep(tick, maximumEntries);
    },
    metrics() {
      return namespace.metrics();
    },
  };
  return Object.freeze(view);
}

function isValidRequest(request: LocalPathPlanRequest): boolean {
  return (
    request.origin.roomName === request.goal.roomName &&
    isFinitePosition(request.origin) &&
    isFinitePosition(request.goal) &&
    Number.isSafeInteger(request.range) &&
    request.range >= 0 &&
    Number.isFinite(request.availableCpu) &&
    request.availableCpu >= 0 &&
    Number.isFinite(request.estimatedSearchCpu) &&
    request.estimatedSearchCpu >= 0 &&
    Number.isSafeInteger(request.tick) &&
    request.tick >= 0 &&
    request.staticMatrixRevision.length > 0 &&
    (request.bypassCache === undefined || typeof request.bypassCache === "boolean")
  );
}

function isFinitePosition(position: PositionSnapshot): boolean {
  return (
    position.roomName.length > 0 &&
    Number.isSafeInteger(position.x) &&
    Number.isSafeInteger(position.y) &&
    position.x >= 0 &&
    position.x <= 49 &&
    position.y >= 0 &&
    position.y <= 49
  );
}

function canonicalBlockedPositions(
  positions: readonly PositionSnapshot[],
  origin: PositionSnapshot,
): readonly PositionSnapshot[] | null {
  if (positions.length > MAX_DYNAMIC_MOVEMENT_BLOCKERS) return null;
  const canonical = new Map<string, PositionSnapshot>();
  for (const position of positions) {
    if (!isFinitePosition(position) || position.roomName !== origin.roomName) return null;
    if (position.x === origin.x && position.y === origin.y) continue;
    canonical.set(positionKey(position), position);
  }
  return Object.freeze(
    [...canonical.values()]
      .sort((left, right) => left.y - right.y || left.x - right.x)
      .map((position) => Object.freeze({ ...position })),
  );
}

function isDirection(value: number): value is DirectionConstant {
  return Number.isSafeInteger(value) && value >= 1 && value <= 8;
}

function isValidStaticMatrix(
  matrix: StaticTraversalMatrix,
  roomName: string,
  revision: string,
): boolean {
  return (
    matrix.roomName === roomName &&
    matrix.revision === revision &&
    isValidWalkability(matrix.walkability)
  );
}

function isValidLocalPath(path: LocalPath, roomName: string): boolean {
  return (
    path.roomName === roomName &&
    Number.isSafeInteger(path.cost) &&
    path.cost > 0 &&
    path.directions.length > 0 &&
    path.directions.every(isDirection)
  );
}

function isValidWalkability(walkability: string): boolean {
  return walkability.length === 2_500 && /^[.#]+$/u.test(walkability);
}

function positionKey(position: PositionSnapshot): string {
  return `${String(position.x)},${String(position.y)}`;
}
