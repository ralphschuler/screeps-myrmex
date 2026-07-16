import {
  createJsonCacheCodec,
  type CacheManager,
  type CacheNamespace,
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
  readonly goal: PositionSnapshot;
  readonly origin: PositionSnapshot;
  readonly range: number;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}

export interface LocalPathPlanningService {
  plan(request: LocalPathPlanningRequest): LocalPathPlanResult;
}

const LOCAL_PATH_SEARCH_CPU_ESTIMATE = 0.5;

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
      const pathKey = [
        request.origin.roomName,
        `${request.staticMatrixRevision}:${positionKey(request.origin)}:${positionKey(request.goal)}:${String(request.range)}:${String(this.policy.maximumSearchOperations)}:${String(this.policy.maximumPathCost)}`,
      ] as const;
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

/**
 * Registers the two bounded, reconstructible movement namespaces once per heap CacheManager.
 * Dynamic occupancy, reservations, and live game objects are deliberately absent from both values.
 */
export function getMovementPathCache(manager: CacheManager): MovementPathCache {
  const existing = caches.get(manager);
  if (existing !== undefined) return existing;
  const staticMatrices = manager.register<readonly [string, string], StaticTraversalMatrix>({
    id: "movement.static-matrix.v1",
    owner: "movement.path-cache",
    version: 1,
    capacity: 64,
    maxKeyLength: 256,
    maxEncodedLength: 12_000,
    estimatedRebuildCpu: 0.5,
    ttlTicks: null,
    keyOf: (key) => key,
    codec: createJsonCacheCodec<StaticTraversalMatrix>(),
  });
  const localPaths = manager.register<readonly [string, string], LocalPath>({
    id: "movement.local-path.v2",
    owner: "movement.path-cache",
    version: 2,
    capacity: 256,
    maxKeyLength: 512,
    maxEncodedLength: 2_048,
    estimatedRebuildCpu: 0.25,
    ttlTicks: 25,
    keyOf: (key) => key,
    codec: createJsonCacheCodec<LocalPath>(),
  });
  const created = Object.freeze({ localPaths, staticMatrices });
  caches.set(manager, created);
  return created;
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
    request.staticMatrixRevision.length > 0
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
