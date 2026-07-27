export const ROUTE_PLANNER_LIMITS = Object.freeze({
  maximumDeadlineTicks: 50_000,
  maximumEvidenceRooms: 64,
  maximumExitsPerRoom: 4,
  maximumIdentityCodeUnits: 160,
  maximumPlanCodeUnits: 8_192,
  maximumRequestsPerTick: 8,
  maximumRouteRooms: 16,
  maximumThreatRisk: 10_000,
  minimumColdSearchCpuMilli: 250,
  modeledCrossingStepsPerRoom: 50,
} as const);

export type RouteRoomStatus = "normal" | "closed" | "novice" | "respawn";
export type RouteRoomRelation =
  "self" | "ally" | "nap" | "neutral" | "trespasser" | "hostile" | "war";
export type RouteEvidenceFreshness = "current" | "fresh" | "stale" | "expired" | "unknown";
export type RouteEvidenceQuality = "complete" | "partial" | "unknown";

export interface RouteTerrainSample {
  readonly road: number;
  readonly plain: number;
  readonly swamp: number;
}

/** Detached room-graph evidence. Identity classification comes from diplomacy/threat owners. */
export interface RouteRoomEvidence {
  readonly roomName: string;
  readonly exits: readonly string[];
  readonly status: RouteRoomStatus;
  readonly relation: RouteRoomRelation;
  readonly freshness: RouteEvidenceFreshness;
  readonly quality: RouteEvidenceQuality;
  readonly threatRisk: number;
  readonly terrain: RouteTerrainSample | null;
}

export interface RouteBodyProfile {
  readonly moveParts: number;
  readonly carryParts: number;
  readonly nonMoveNonCarryParts: number;
  readonly outboundLoadedCarryParts: number;
  readonly returnLoadedCarryParts: number;
  readonly initialFatigue: number;
}

export interface RoutePolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly allowProtectedRooms: boolean;
  readonly baseRoomCost: number;
  readonly highwayDiscount: number;
  readonly roadStepCost: number;
  readonly plainStepCost: number;
  readonly swampStepCost: number;
  readonly threatCostPerRisk: number;
  readonly relationCosts: Readonly<Record<RouteRoomRelation, number>>;
}

export interface RouteSearchBudget {
  readonly maximumExpandedRooms: number;
  readonly maximumRouteRooms: number;
  readonly maximumTotalCost: number;
  readonly maximumRisk: number;
  readonly maximumPlanCodeUnits: number;
}

export interface RoutePlanRequest {
  readonly id: string;
  readonly originRoomName: string;
  readonly destinationRoomName: string;
  readonly tick: number;
  readonly deadline: number;
  /** Remaining CpuScheduler-authorized planning budget. Cached reads do not spend this allowance. */
  readonly availableCpuMilli: number;
  readonly topologyRevision: string;
  readonly intelRevision: string;
  readonly diplomacyRevision: string;
  readonly threatRevision: string;
  readonly policy: RoutePolicyV1;
  readonly body: RouteBodyProfile;
  readonly budget: RouteSearchBudget;
  readonly rooms: readonly RouteRoomEvidence[];
}

export interface RouteTravelEstimate {
  readonly outboundTicks: number;
  readonly returnTicks: number;
  readonly roundTripTicks: number;
  readonly throughputMilliCapacityPerTick: number;
  readonly roadSteps: number;
  readonly plainSteps: number;
  readonly swampSteps: number;
  /** Abstract road exposure: crossed road tiles × body parts × both directions. */
  readonly roadBodyPartSteps: number;
}

export interface RoutePlanV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly originRoomName: string;
  readonly destinationRoomName: string;
  /** Entered rooms in order; origin is excluded and destination is included. */
  readonly roomNames: readonly string[];
  readonly totalCost: number;
  readonly risk: number;
  readonly estimate: RouteTravelEstimate;
}

export type RoutePlanStatus =
  "ready" | "stale-route" | "unsafe-route" | "no-route" | "deferred" | "invalid";

export type RoutePlanReason =
  | "route-cache-hit"
  | "route-computed"
  | "request-budget"
  | "stale-intel"
  | "unsafe-risk"
  | "no-path"
  | "cpu-budget"
  | "search-budget"
  | "cost-budget"
  | "memory-budget"
  | "timeout"
  | "invalid-input";

export interface RoutePlanMetrics {
  readonly expandedRooms: number;
  readonly consideredEdges: number;
  readonly cacheHits: number;
  readonly routeRooms: number;
  readonly totalCost: number;
  readonly risk: number;
  readonly reason: RoutePlanReason;
}

export interface RoutePlanResult {
  readonly status: RoutePlanStatus;
  readonly reason: RoutePlanReason;
  readonly source: "cache" | "search" | "none";
  readonly plan: RoutePlanV1 | null;
  readonly metrics: RoutePlanMetrics;
}
