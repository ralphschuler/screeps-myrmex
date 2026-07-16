import {
  MAX_ALLOCATION_PAIRS,
  type TravelEstimateView,
  type WorkforceActor,
  type WorkContractRecord,
} from "../contracts";
import type { LocalPathPlanningService, LocalPathPlanResult } from "../movement/path-cache";
import type { PositionSnapshot, WorldSnapshot } from "../world/snapshot";

export const LOCAL_PATH_TRAVEL_SEARCH_CPU = 0.5;

interface RouteEvidence {
  readonly cost: number;
  readonly steps: number;
}

export interface LocalPathTravelEstimateInput {
  /** CpuScheduler admission budget available to cold local-path searches. */
  readonly availableCpu: number;
  readonly paths: LocalPathPlanningService;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}

/**
 * Runtime composition adapter between contract allocation and the canonical local-path service.
 * It has no durable authority: estimates and the bounded geometry memo live for one reconciliation.
 */
export function createLocalPathTravelEstimateView(
  input: LocalPathTravelEstimateInput,
): TravelEstimateView {
  const memo = new Map<string, RouteEvidence | null>();
  const enabled = validInput(input);
  let remainingSearchCpu = enabled ? input.availableCpu : 0;

  return Object.freeze({
    estimate(actor: WorkforceActor, contract: WorkContractRecord): number | null {
      if (!enabled) return null;
      const origin = positionProperty(actor, "pos");
      const goal = positionProperty(contract, "target");
      const range = contractRange(contract);
      if (origin === null || goal === null || range === null) return null;
      if (origin.roomName !== goal.roomName) return null;
      if (chebyshevRange(origin, goal) <= range) return 0;

      const key = geometryKey(origin, goal, range);
      if (memo.has(key)) return modeledTravelTicks(actor, memo.get(key) ?? null);
      if (memo.size >= MAX_ALLOCATION_PAIRS) return null;

      const availableCpu = remainingSearchCpu;
      let result: LocalPathPlanResult;
      try {
        result = input.paths.plan({
          availableCpu,
          goal,
          origin,
          range,
          snapshot: input.snapshot,
          tick: input.tick,
        });
      } catch {
        remainingSearchCpu = spendSearchCpu(remainingSearchCpu);
        memo.set(key, null);
        return null;
      }

      if (consumedColdSearch(result)) {
        remainingSearchCpu = spendSearchCpu(remainingSearchCpu);
      }
      const route = readyRouteEvidence(result, availableCpu);
      memo.set(key, route);
      return modeledTravelTicks(actor, route);
    },
  });
}

/** Retains a system's declared base estimate before optional cold path searches. */
export function localPathSearchAllowance(input: {
  readonly available: number;
  readonly estimate: number;
}): number {
  return Number.isFinite(input.available) &&
    input.available >= 0 &&
    Number.isFinite(input.estimate) &&
    input.estimate >= 0
    ? Math.max(0, input.available - input.estimate)
    : 0;
}

function validInput(input: LocalPathTravelEstimateInput): boolean {
  return (
    Number.isFinite(input.availableCpu) &&
    input.availableCpu >= 0 &&
    Number.isSafeInteger(input.tick) &&
    input.tick >= 0 &&
    typeof input.paths.plan === "function" &&
    hasRoomCollection(input.snapshot)
  );
}

function hasRoomCollection(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "rooms" in value && Array.isArray(value.rooms)
  );
}

function positionProperty(value: unknown, key: "pos" | "target"): PositionSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!(key in record)) return null;
  const position = record[key];
  if (typeof position !== "object" || position === null) return null;
  if (!("roomName" in position) || !("x" in position) || !("y" in position)) return null;
  if (
    typeof position.roomName !== "string" ||
    position.roomName.length === 0 ||
    !Number.isSafeInteger(position.x) ||
    !Number.isSafeInteger(position.y) ||
    (position.x as number) < 0 ||
    (position.x as number) > 49 ||
    (position.y as number) < 0 ||
    (position.y as number) > 49
  )
    return null;
  return position as PositionSnapshot;
}

function contractRange(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("range" in value)) return null;
  return Number.isSafeInteger(value.range) &&
    (value.range as number) >= 0 &&
    (value.range as number) <= 50
    ? (value.range as number)
    : null;
}

function chebyshevRange(origin: PositionSnapshot, goal: PositionSnapshot): number {
  return Math.max(Math.abs(origin.x - goal.x), Math.abs(origin.y - goal.y));
}

function geometryKey(origin: PositionSnapshot, goal: PositionSnapshot, range: number): string {
  return JSON.stringify([
    origin.roomName,
    origin.x,
    origin.y,
    goal.roomName,
    goal.x,
    goal.y,
    range,
  ]);
}

function consumedColdSearch(result: LocalPathPlanResult): boolean {
  return (
    (result.status === "ready" && result.source === "search") ||
    (result.status === "no-path" &&
      (result.reason === "adapter-fault" || result.reason === "incomplete"))
  );
}

function spendSearchCpu(remaining: number): number {
  return Math.max(0, remaining - LOCAL_PATH_TRAVEL_SEARCH_CPU);
}

function readyRouteEvidence(
  result: LocalPathPlanResult,
  availableCpu: number,
): RouteEvidence | null {
  if (result.status !== "ready" || !Array.isArray(result.directions)) return null;
  if (result.source === "search" && availableCpu < LOCAL_PATH_TRAVEL_SEARCH_CPU) return null;
  const steps = result.directions.length;
  return Number.isSafeInteger(steps) &&
    steps > 0 &&
    Number.isSafeInteger(result.cost) &&
    result.cost > 0
    ? Object.freeze({ cost: result.cost, steps })
    : null;
}

function modeledTravelTicks(actor: WorkforceActor, route: RouteEvidence | null): number | null {
  if (route === null) return null;
  const move = actor.capability.move;
  const fatigue = actor.fatigue;
  const weight = actor.movementWeight;
  if (
    !Number.isSafeInteger(move) ||
    move <= 0 ||
    !Number.isSafeInteger(fatigue) ||
    (fatigue ?? -1) < 0 ||
    !Number.isSafeInteger(weight) ||
    (weight ?? -1) < 0
  )
    return null;
  const recoveryPerTick = move * 2;
  // PathFinder's default plain/swamp costs are half their movement-fatigue factors (1/5 versus
  // 2/10). Convert the route cost before applying conservative body weight.
  const routeFatigue = route.cost * 2 * (weight as number);
  if (!Number.isSafeInteger(recoveryPerTick) || !Number.isSafeInteger(routeFatigue)) return null;
  // Adding the step count to fatigue recovery intentionally overestimates travel and includes a
  // safe final-step margin instead of assuming one direction per tick.
  const travelTicks =
    Math.ceil((fatigue as number) / recoveryPerTick) +
    route.steps +
    Math.ceil(routeFatigue / recoveryPerTick);
  return Number.isSafeInteger(travelTicks) && travelTicks > 0 ? travelTicks : null;
}
