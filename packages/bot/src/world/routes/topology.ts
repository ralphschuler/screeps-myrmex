import { ROUTE_PLANNER_LIMITS, type RouteRoomStatus } from "./contracts";

export interface RouteMapView {
  readonly describeExits: (roomName: string) => Readonly<Record<string | number, string>> | null;
  readonly getRoomStatus: (roomName: string) => {
    readonly status: string;
    readonly timestamp: number | null;
  };
}

export interface RouteTopologyRoom {
  readonly roomName: string;
  readonly exits: readonly string[];
  readonly status: RouteRoomStatus;
  /** Game.map status expiration in Unix milliseconds; null means no announced expiration. */
  readonly timestamp: number | null;
}

export interface RouteTopologyObservation {
  readonly status: "ready" | "invalid-input" | "limit-exceeded" | "unavailable";
  readonly rooms: readonly RouteTopologyRoom[];
}

/**
 * Bounded world-observation adapter for current Game.map exits and status.
 * It makes no route choice and never exposes the live map object to RoutePlanner.
 */
export function observeRouteTopology(input: {
  readonly roomNames: readonly string[];
  readonly map: RouteMapView;
}): RouteTopologyObservation {
  if (input.roomNames.some((name) => !validRoomName(name))) return empty("invalid-input");
  if (input.roomNames.length > ROUTE_PLANNER_LIMITS.maximumEvidenceRooms) {
    return empty("limit-exceeded");
  }
  if (
    input.roomNames.length === 0 ||
    new Set(input.roomNames).size !== input.roomNames.length ||
    typeof input.map.describeExits !== "function" ||
    typeof input.map.getRoomStatus !== "function"
  ) {
    return empty("invalid-input");
  }
  const rooms: RouteTopologyRoom[] = [];
  try {
    for (const roomName of [...input.roomNames].sort(compare)) {
      const described = input.map.describeExits(roomName);
      const roomStatus = input.map.getRoomStatus(roomName);
      const status = routeRoomStatus(roomStatus.status);
      if (described === null || status === null || !validTimestamp(roomStatus.timestamp)) {
        return empty("unavailable");
      }
      const exits = Object.values(described);
      if (
        exits.length > ROUTE_PLANNER_LIMITS.maximumExitsPerRoom ||
        exits.some((exit) => !validRoomName(exit)) ||
        new Set(exits).size !== exits.length
      ) {
        return empty("unavailable");
      }
      rooms.push({
        roomName,
        exits: [...exits].sort(compare),
        status,
        timestamp: roomStatus.timestamp,
      });
    }
  } catch {
    return empty("unavailable");
  }
  return deepFreeze({ status: "ready", rooms });
}

function routeRoomStatus(value: string): RouteRoomStatus | null {
  return value === "normal" || value === "closed" || value === "novice" || value === "respawn"
    ? value
    : null;
}
function validTimestamp(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function empty(
  status: Exclude<RouteTopologyObservation["status"], "ready">,
): RouteTopologyObservation {
  return Object.freeze({ status, rooms: Object.freeze([]) });
}
function validRoomName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16 && /^(W|E)\d+(N|S)\d+$/u.test(value);
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
