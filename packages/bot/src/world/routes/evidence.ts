import type { RoomIntelQueryResult } from "../intel";
import {
  ROUTE_PLANNER_LIMITS,
  type RouteRoomEvidence,
  type RouteRoomRelation,
  type RouteRoomStatus,
  type RouteTerrainSample,
} from "./contracts";

export interface RouteRoomEvidenceInput {
  readonly roomName: string;
  readonly exits: readonly string[];
  readonly status: RouteRoomStatus;
  /** Authoritative configured/observed diplomacy projection; no player identity is accepted here. */
  readonly relation: RouteRoomRelation;
  /** Bounded score from the threat authority; hostile collections are not reclassified here. */
  readonly threatRisk: number;
  readonly intel: RoomIntelQueryResult;
}

/** Converts IntelService output plus map/diplomacy/threat projections into detached route evidence. */
export function projectRouteRoomEvidence(input: RouteRoomEvidenceInput): RouteRoomEvidence | null {
  if (
    !validRoomName(input.roomName) ||
    !Array.isArray(input.exits) ||
    input.exits.length > ROUTE_PLANNER_LIMITS.maximumExitsPerRoom ||
    !input.exits.every(validRoomName) ||
    new Set(input.exits).size !== input.exits.length ||
    input.intel.roomName !== input.roomName ||
    !["normal", "closed", "novice", "respawn"].includes(input.status) ||
    !["self", "ally", "nap", "neutral", "trespasser", "hostile", "war"].includes(input.relation) ||
    !Number.isSafeInteger(input.threatRisk) ||
    input.threatRisk < 0 ||
    input.threatRisk > ROUTE_PLANNER_LIMITS.maximumThreatRisk
  ) {
    return null;
  }
  const terrain = terrainSample(input.intel);
  return deepFreeze({
    roomName: input.roomName,
    exits: [...input.exits].sort(compare),
    status: input.status,
    relation: input.relation,
    freshness: input.intel.freshness,
    quality: input.intel.quality,
    threatRisk: input.threatRisk,
    terrain,
  });
}

function terrainSample(intel: RoomIntelQueryResult): RouteTerrainSample | null {
  const record = intel.record;
  const cells = record?.terrain?.cells;
  if (record === null || typeof cells !== "string" || !/^[012]{2500}$/u.test(cells)) return null;
  let plain = 0;
  let swamp = 0;
  for (const cell of cells) {
    if (cell === "0") plain += 1;
    else if (cell === "2") swamp += 1;
  }
  const roadPositions = new Set<string>();
  for (const structure of record.structures) {
    if (structure.structureType !== "road") continue;
    const index = structure.pos.y * 50 + structure.pos.x;
    const cell = cells[index];
    if (cell !== "0" && cell !== "2") continue;
    roadPositions.add(`${String(structure.pos.x)},${String(structure.pos.y)}`);
  }
  for (const key of roadPositions) {
    const [xText, yText] = key.split(",");
    const x = Number(xText);
    const y = Number(yText);
    const cell = cells[y * 50 + x];
    if (cell === "0") plain -= 1;
    else if (cell === "2") swamp -= 1;
  }
  return { road: roadPositions.size, plain, swamp };
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
