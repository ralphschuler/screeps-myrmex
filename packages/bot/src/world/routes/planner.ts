import type { CacheDependencyStamp } from "../../cache";
import type { RoutePlanCache, RoutePlanCacheKey } from "./cache";
import {
  ROUTE_PLANNER_LIMITS,
  type RouteBodyProfile,
  type RoutePlanMetrics,
  type RoutePlanReason,
  type RoutePlanRequest,
  type RoutePlanResult,
  type RoutePlanV1,
  type RoutePolicyV1,
  type RouteRoomEvidence,
  type RouteRoomRelation,
  type RouteTerrainSample,
  type RouteTravelEstimate,
} from "./contracts";

interface SearchState {
  readonly roomName: string;
  readonly roomNames: readonly string[];
  readonly totalCost: number;
  readonly risk: number;
  readonly stale: boolean;
}

interface SearchResult {
  readonly status: "found" | "no-path" | "budget";
  readonly state: SearchState | null;
  readonly expandedRooms: number;
  readonly consideredEdges: number;
}

/**
 * Sole deterministic room-graph route and travel-estimate authority.
 *
 * The planner owns no map observation, diplomacy decision, threat decision, command, reservation,
 * or persistent state. Callers supply detached owner-qualified evidence and explicit search bounds.
 */
export class RoutePlanner {
  private requestTick: number | null = null;
  private requestsThisTick = 0;

  public constructor(private readonly cache: RoutePlanCache) {}

  public plan(request: RoutePlanRequest): RoutePlanResult {
    let graph: ReadonlyMap<string, RouteRoomEvidence> | null;
    try {
      graph = validateRequest(request);
    } catch {
      return result("invalid", "invalid-input", "none", null, metrics());
    }
    if (graph === null) return result("invalid", "invalid-input", "none", null, metrics());
    if (this.requestTick !== request.tick) {
      this.requestTick = request.tick;
      this.requestsThisTick = 0;
    }
    if (this.requestsThisTick >= ROUTE_PLANNER_LIMITS.maximumRequestsPerTick) {
      return result("deferred", "request-budget", "none", null, metrics());
    }
    this.requestsThisTick += 1;
    if (request.tick > request.deadline)
      return result("deferred", "timeout", "none", null, metrics());

    const key = cacheKey(request);
    const dependencies = cacheDependencies(request);
    const cached = this.cache.plans.get(key, { dependencies, tick: request.tick });
    if (cached.hit && validCachedPlan(cached.value, request, graph)) {
      const encodedLength = JSON.stringify(cached.value).length;
      if (encodedLength > request.budget.maximumPlanCodeUnits)
        return result("deferred", "memory-budget", "cache", null, metrics({ cacheHits: 1 }));
      const plan = deepFreeze(cached.value);
      return result(
        "ready",
        "route-cache-hit",
        "cache",
        plan,
        metrics({
          cacheHits: 1,
          routeRooms: plan.roomNames.length,
          totalCost: plan.totalCost,
          risk: plan.risk,
        }),
      );
    }
    if (request.availableCpuMilli < ROUTE_PLANNER_LIMITS.minimumColdSearchCpuMilli) {
      return result("deferred", "cpu-budget", "none", null, metrics());
    }

    const searched = searchGraph(request, graph);
    const baseMetrics = metrics({
      expandedRooms: searched.expandedRooms,
      consideredEdges: searched.consideredEdges,
      routeRooms: searched.state?.roomNames.length ?? 0,
      totalCost: searched.state?.totalCost ?? 0,
      risk: searched.state?.risk ?? 0,
    });
    if (searched.status === "budget")
      return result("deferred", "search-budget", "search", null, baseMetrics);
    if (searched.status === "no-path" || searched.state === null)
      return result("no-route", "no-path", "search", null, baseMetrics);
    if (searched.state.stale)
      return result("stale-route", "stale-intel", "search", null, baseMetrics);
    if (searched.state.risk > request.budget.maximumRisk)
      return result("unsafe-route", "unsafe-risk", "search", null, baseMetrics);
    if (searched.state.totalCost > request.budget.maximumTotalCost)
      return result("deferred", "cost-budget", "search", null, baseMetrics);

    const estimate = estimateTravel(searched.state.roomNames, graph, request.body);
    if (estimate === null) return result("invalid", "invalid-input", "search", null, baseMetrics);
    const plan = deepFreeze<RoutePlanV1>({
      schemaVersion: 1,
      requestId: request.id,
      originRoomName: request.originRoomName,
      destinationRoomName: request.destinationRoomName,
      roomNames: searched.state.roomNames,
      totalCost: searched.state.totalCost,
      risk: searched.state.risk,
      estimate,
    });
    const encodedLength = JSON.stringify(plan).length;
    if (
      encodedLength > request.budget.maximumPlanCodeUnits ||
      encodedLength > ROUTE_PLANNER_LIMITS.maximumPlanCodeUnits
    ) {
      return result("deferred", "memory-budget", "search", null, baseMetrics);
    }
    try {
      this.cache.plans.set(key, plan, { dependencies, tick: request.tick });
    } catch {
      // Heap-cache admission may reduce quality but cannot change a valid deterministic route.
    }
    return result(
      "ready",
      "route-computed",
      "search",
      plan,
      metrics({
        ...baseMetrics,
        routeRooms: plan.roomNames.length,
        totalCost: plan.totalCost,
        risk: plan.risk,
      }),
    );
  }
}

function searchGraph(
  request: RoutePlanRequest,
  graph: ReadonlyMap<string, RouteRoomEvidence>,
): SearchResult {
  const queue: SearchState[] = [
    { roomName: request.originRoomName, roomNames: [], totalCost: 0, risk: 0, stale: false },
  ];
  let expandedRooms = 0;
  let consideredEdges = 0;
  while (queue.length > 0) {
    queue.sort((left, right) => compareSearchState(left, right, request.budget.maximumRisk));
    const state = queue.shift();
    if (state === undefined) break;
    if (state.roomName === request.destinationRoomName) {
      return { status: "found", state, expandedRooms, consideredEdges };
    }
    if (expandedRooms >= request.budget.maximumExpandedRooms) {
      return { status: "budget", state: null, expandedRooms, consideredEdges };
    }
    expandedRooms += 1;
    const room = graph.get(state.roomName);
    if (room === undefined) continue;
    for (const nextRoomName of [...room.exits].sort(compare)) {
      consideredEdges += 1;
      if (state.roomNames.includes(nextRoomName) || nextRoomName === request.originRoomName)
        continue;
      const next = graph.get(nextRoomName);
      if (next === undefined || !statusAllowsEntry(next, request.policy)) continue;
      if (state.roomNames.length >= request.budget.maximumRouteRooms) continue;
      const entryCost = roomEntryCost(next, request.policy);
      const totalCost = safeAdd(state.totalCost, entryCost);
      const risk = safeAdd(state.risk, next.threatRisk);
      if (totalCost === null || risk === null) continue;
      queue.push({
        roomName: nextRoomName,
        roomNames: [...state.roomNames, nextRoomName],
        totalCost,
        risk,
        stale: state.stale || !freshCompleteEvidence(next),
      });
    }
  }
  return { status: "no-path", state: null, expandedRooms, consideredEdges };
}

function compareSearchState(left: SearchState, right: SearchState, maximumRisk: number): number {
  const leftClass = left.stale ? 2 : left.risk > maximumRisk ? 1 : 0;
  const rightClass = right.stale ? 2 : right.risk > maximumRisk ? 1 : 0;
  return (
    leftClass - rightClass ||
    left.totalCost - right.totalCost ||
    left.roomNames.length - right.roomNames.length ||
    compare(left.roomNames.join("\u0000"), right.roomNames.join("\u0000"))
  );
}

function roomEntryCost(room: RouteRoomEvidence, policy: RoutePolicyV1): number {
  const terrain = room.terrain === null ? null : modeledTerrainSteps(room.terrain);
  const terrainCost =
    terrain === null
      ? 0
      : terrain.road * policy.roadStepCost +
        terrain.plain * policy.plainStepCost +
        terrain.swamp * policy.swampStepCost;
  const highwayDiscount = isHighway(room.roomName) ? policy.highwayDiscount : 0;
  return (
    policy.baseRoomCost -
    highwayDiscount +
    terrainCost +
    policy.relationCosts[room.relation] +
    room.threatRisk * policy.threatCostPerRisk
  );
}

function estimateTravel(
  roomNames: readonly string[],
  graph: ReadonlyMap<string, RouteRoomEvidence>,
  body: RouteBodyProfile,
): RouteTravelEstimate | null {
  let roadSteps = 0;
  let plainSteps = 0;
  let swampSteps = 0;
  for (const roomName of roomNames) {
    const terrain = graph.get(roomName)?.terrain;
    if (terrain === null || terrain === undefined) return null;
    const steps = modeledTerrainSteps(terrain);
    roadSteps += steps.road;
    plainSteps += steps.plain;
    swampSteps += steps.swamp;
  }
  const recovery = body.moveParts * 2;
  const outboundWeight = body.nonMoveNonCarryParts + body.outboundLoadedCarryParts;
  const returnWeight = body.nonMoveNonCarryParts + body.returnLoadedCarryParts;
  const outboundTicks =
    Math.ceil(body.initialFatigue / recovery) +
    surfaceTicks(roadSteps, plainSteps, swampSteps, outboundWeight, recovery);
  const returnTicks = surfaceTicks(roadSteps, plainSteps, swampSteps, returnWeight, recovery);
  const roundTripTicks = outboundTicks + returnTicks;
  const capacity = Math.max(body.outboundLoadedCarryParts, body.returnLoadedCarryParts) * 50;
  const bodyParts = body.moveParts + body.carryParts + body.nonMoveNonCarryParts;
  const roadBodyPartSteps = roadSteps * bodyParts * 2;
  const throughputMilliCapacityPerTick =
    roundTripTicks === 0 ? 0 : Math.floor((capacity * 1_000) / roundTripTicks);
  if (
    ![
      outboundTicks,
      returnTicks,
      roundTripTicks,
      throughputMilliCapacityPerTick,
      roadBodyPartSteps,
    ].every(Number.isSafeInteger)
  ) {
    return null;
  }
  return deepFreeze({
    outboundTicks,
    returnTicks,
    roundTripTicks,
    throughputMilliCapacityPerTick,
    roadSteps,
    plainSteps,
    swampSteps,
    roadBodyPartSteps,
  });
}

function surfaceTicks(
  roadSteps: number,
  plainSteps: number,
  swampSteps: number,
  weight: number,
  recovery: number,
): number {
  if (weight === 0) return roadSteps + plainSteps + swampSteps;
  return (
    roadSteps * Math.max(1, Math.ceil(weight / recovery)) +
    plainSteps * Math.max(1, Math.ceil((weight * 2) / recovery)) +
    swampSteps * Math.max(1, Math.ceil((weight * 10) / recovery))
  );
}

function modeledTerrainSteps(sample: RouteTerrainSample): RouteTerrainSample {
  const total = sample.road + sample.plain + sample.swamp;
  const road = Math.floor((ROUTE_PLANNER_LIMITS.modeledCrossingStepsPerRoom * sample.road) / total);
  const swamp = Math.floor(
    (ROUTE_PLANNER_LIMITS.modeledCrossingStepsPerRoom * sample.swamp) / total,
  );
  return {
    road,
    swamp,
    plain: ROUTE_PLANNER_LIMITS.modeledCrossingStepsPerRoom - road - swamp,
  };
}

function validateRequest(request: RoutePlanRequest): ReadonlyMap<string, RouteRoomEvidence> | null {
  if (
    !boundedIdentity(request.id) ||
    !validRoomName(request.originRoomName) ||
    !validRoomName(request.destinationRoomName) ||
    request.originRoomName === request.destinationRoomName ||
    !nonnegative(request.tick) ||
    !nonnegative(request.deadline) ||
    request.deadline - request.tick > ROUTE_PLANNER_LIMITS.maximumDeadlineTicks ||
    !nonnegative(request.availableCpuMilli) ||
    !boundedIdentity(request.topologyRevision) ||
    !boundedIdentity(request.intelRevision) ||
    !boundedIdentity(request.diplomacyRevision) ||
    !boundedIdentity(request.threatRevision) ||
    !validPolicy(request.policy) ||
    !validBody(request.body) ||
    !validBudget(request.budget) ||
    request.rooms.length === 0 ||
    request.rooms.length > ROUTE_PLANNER_LIMITS.maximumEvidenceRooms
  ) {
    return null;
  }
  const graph = new Map<string, RouteRoomEvidence>();
  for (const room of request.rooms) {
    if (!validRoom(room) || graph.has(room.roomName)) return null;
    graph.set(room.roomName, canonicalRoom(room));
  }
  return graph.has(request.originRoomName) && graph.has(request.destinationRoomName) ? graph : null;
}

function validRoom(room: RouteRoomEvidence): boolean {
  return (
    validRoomName(room.roomName) &&
    room.exits.length <= ROUTE_PLANNER_LIMITS.maximumExitsPerRoom &&
    room.exits.every(validRoomName) &&
    new Set(room.exits).size === room.exits.length &&
    ["normal", "closed", "novice", "respawn"].includes(room.status) &&
    ["self", "ally", "nap", "neutral", "trespasser", "hostile", "war"].includes(room.relation) &&
    ["current", "fresh", "stale", "expired", "unknown"].includes(room.freshness) &&
    ["complete", "partial", "unknown"].includes(room.quality) &&
    nonnegative(room.threatRisk) &&
    room.threatRisk <= ROUTE_PLANNER_LIMITS.maximumThreatRisk &&
    (room.terrain === null || validTerrain(room.terrain))
  );
}

function validTerrain(terrain: RouteTerrainSample): boolean {
  const values = [terrain.road, terrain.plain, terrain.swamp];
  const total = terrain.road + terrain.plain + terrain.swamp;
  return values.every(nonnegative) && total > 0 && total <= 2_500 && Number.isSafeInteger(total);
}

function validBody(body: RouteBodyProfile): boolean {
  const values = [
    body.moveParts,
    body.carryParts,
    body.nonMoveNonCarryParts,
    body.outboundLoadedCarryParts,
    body.returnLoadedCarryParts,
    body.initialFatigue,
  ];
  const size = body.moveParts + body.carryParts + body.nonMoveNonCarryParts;
  return (
    values.every(nonnegative) &&
    body.moveParts > 0 &&
    size > 0 &&
    size <= 50 &&
    body.outboundLoadedCarryParts <= body.carryParts &&
    body.returnLoadedCarryParts <= body.carryParts
  );
}

function validBudget(budget: RoutePlanRequest["budget"]): boolean {
  return (
    positive(budget.maximumExpandedRooms) &&
    budget.maximumExpandedRooms <= ROUTE_PLANNER_LIMITS.maximumEvidenceRooms &&
    positive(budget.maximumRouteRooms) &&
    budget.maximumRouteRooms <= ROUTE_PLANNER_LIMITS.maximumRouteRooms &&
    positive(budget.maximumTotalCost) &&
    nonnegative(budget.maximumRisk) &&
    budget.maximumRisk <= ROUTE_PLANNER_LIMITS.maximumThreatRisk &&
    positive(budget.maximumPlanCodeUnits) &&
    budget.maximumPlanCodeUnits <= ROUTE_PLANNER_LIMITS.maximumPlanCodeUnits
  );
}

function validPolicy(policy: RoutePolicyV1): boolean {
  const relations: readonly RouteRoomRelation[] = [
    "self",
    "ally",
    "nap",
    "neutral",
    "trespasser",
    "hostile",
    "war",
  ];
  return (
    hasSchemaVersionOne(policy) &&
    boundedIdentity(policy.revision) &&
    typeof policy.allowProtectedRooms === "boolean" &&
    positive(policy.baseRoomCost) &&
    nonnegative(policy.highwayDiscount) &&
    policy.highwayDiscount < policy.baseRoomCost &&
    nonnegative(policy.roadStepCost) &&
    nonnegative(policy.plainStepCost) &&
    nonnegative(policy.swampStepCost) &&
    nonnegative(policy.threatCostPerRisk) &&
    relations.every((relation) => nonnegative(policy.relationCosts[relation])) &&
    Object.keys(policy.relationCosts).length === relations.length
  );
}

function canonicalRoom(room: RouteRoomEvidence): RouteRoomEvidence {
  return deepFreeze({
    ...room,
    exits: [...room.exits].sort(compare),
    terrain: room.terrain === null ? null : { ...room.terrain },
  });
}

function statusAllowsEntry(room: RouteRoomEvidence, policy: RoutePolicyV1): boolean {
  return (
    room.status === "normal" ||
    (policy.allowProtectedRooms && (room.status === "novice" || room.status === "respawn"))
  );
}

function freshCompleteEvidence(room: RouteRoomEvidence): boolean {
  return (
    (room.freshness === "current" || room.freshness === "fresh") &&
    room.quality === "complete" &&
    room.terrain !== null
  );
}

function cacheKey(request: RoutePlanRequest): RoutePlanCacheKey {
  const bodyRevision = JSON.stringify(request.body);
  const budgetRevision = JSON.stringify([
    request.budget.maximumExpandedRooms,
    request.budget.maximumRouteRooms,
    request.budget.maximumTotalCost,
    request.budget.maximumRisk,
  ]);
  return [
    request.id,
    request.originRoomName,
    request.destinationRoomName,
    request.policy.revision,
    bodyRevision,
    budgetRevision,
  ];
}

function cacheDependencies(request: RoutePlanRequest): CacheDependencyStamp {
  return {
    topologyRevision: request.topologyRevision,
    intelRevision: request.intelRevision,
    diplomacyRevision: request.diplomacyRevision,
    threatRevision: request.threatRevision,
    policyRevision: request.policy.revision,
  };
}

function validCachedPlan(
  plan: RoutePlanV1,
  request: RoutePlanRequest,
  graph: ReadonlyMap<string, RouteRoomEvidence>,
): boolean {
  if (
    !hasSchemaVersionOne(plan) ||
    plan.requestId !== request.id ||
    plan.originRoomName !== request.originRoomName ||
    plan.destinationRoomName !== request.destinationRoomName ||
    !isArray(plan.roomNames) ||
    plan.roomNames.length === 0 ||
    plan.roomNames.length > request.budget.maximumRouteRooms ||
    plan.roomNames[plan.roomNames.length - 1] !== request.destinationRoomName ||
    new Set(plan.roomNames).size !== plan.roomNames.length
  ) {
    return false;
  }
  let previous = request.originRoomName;
  let totalCost = 0;
  let risk = 0;
  for (const roomName of plan.roomNames) {
    const prior = graph.get(previous);
    const room = graph.get(roomName);
    if (
      !validRoomName(roomName) ||
      prior === undefined ||
      !prior.exits.includes(roomName) ||
      room === undefined ||
      !statusAllowsEntry(room, request.policy) ||
      !freshCompleteEvidence(room)
    ) {
      return false;
    }
    totalCost = safeAdd(totalCost, roomEntryCost(room, request.policy)) ?? -1;
    risk = safeAdd(risk, room.threatRisk) ?? -1;
    if (totalCost < 0 || risk < 0) return false;
    previous = roomName;
  }
  const estimate = estimateTravel(plan.roomNames, graph, request.body);
  return (
    totalCost === plan.totalCost &&
    risk === plan.risk &&
    totalCost <= request.budget.maximumTotalCost &&
    risk <= request.budget.maximumRisk &&
    estimate !== null &&
    JSON.stringify(estimate) === JSON.stringify(plan.estimate)
  );
}

function result(
  status: RoutePlanResult["status"],
  reason: RoutePlanReason,
  source: RoutePlanResult["source"],
  plan: RoutePlanV1 | null,
  values: RoutePlanMetrics,
): RoutePlanResult {
  return deepFreeze({ status, reason, source, plan, metrics: { ...values, reason } });
}

function metrics(values: Partial<Omit<RoutePlanMetrics, "reason">> = {}): RoutePlanMetrics {
  return {
    expandedRooms: values.expandedRooms ?? 0,
    consideredEdges: values.consideredEdges ?? 0,
    cacheHits: values.cacheHits ?? 0,
    routeRooms: values.routeRooms ?? 0,
    totalCost: values.totalCost ?? 0,
    risk: values.risk ?? 0,
    reason: "invalid-input",
  };
}

function isHighway(roomName: string): boolean {
  const match = /^(?:W|E)(\d+)(?:N|S)(\d+)$/u.exec(roomName);
  return match !== null && (Number(match[1]) % 10 === 0 || Number(match[2]) % 10 === 0);
}

function safeAdd(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}
function hasSchemaVersionOne(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly schemaVersion?: unknown }).schemaVersion === 1
  );
}
function validRoomName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16 && /^(W|E)\d+(N|S)\d+$/u.test(value);
}
function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ROUTE_PLANNER_LIMITS.maximumIdentityCodeUnits &&
    value === value.trim()
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
