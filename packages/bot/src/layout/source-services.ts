import type { PositionSnapshot } from "../world/snapshot";
import type {
  LayoutAdoption,
  LayoutPlacement,
  SourceServiceBlocker,
  SourceServicePlanningInput,
  SourceServicePlanningResult,
} from "./contracts";

const MAX_ROUTE_CELLS = 2_500;

interface RankedCandidate {
  readonly adoption: LayoutAdoption;
  readonly adoptionRank: number;
  readonly pos: PositionSnapshot;
  readonly routeDistance: number;
  readonly terrainRank: number;
}

export function selectSourceServices(
  input: SourceServicePlanningInput,
): SourceServicePlanningResult {
  const placements: LayoutPlacement[] = [];
  const blockers: SourceServiceBlocker[] = [];
  const assigned = new Set<string>();
  const sources = [...input.sources].sort((a, b) => compare(sourceId(a), sourceId(b)));
  const origin = committedOrigin(input.placements);
  let candidatesInspected = 0;

  for (const source of sources) {
    const id = sourceId(source);
    const candidates = adjacent(source);
    candidatesInspected += 8;
    if (source.sourceId === undefined || source.sourceId.length === 0) {
      blockers.push(blocker(id, source, "missing-source-id"));
      continue;
    }
    const ranked = candidates
      .filter((candidate) => !assigned.has(key(candidate)))
      .filter((candidate) => legalCandidate(input, candidate))
      .map((candidate) => rankCandidate(input, candidate, origin))
      .filter((candidate): candidate is RankedCandidate => candidate !== null)
      .sort(compareCandidate);
    const selected = ranked[0];
    if (selected === undefined) {
      blockers.push(blocker(id, source, "no-legal-position"));
      continue;
    }
    assigned.add(key(selected.pos));
    placements.push({
      adoption: selected.adoption,
      layer: "primary",
      minimumRcl: 2,
      pos: selected.pos,
      service: { kind: "source-container", sourceId: id },
      structureType: "container",
    });
  }

  return freeze({
    blockers: blockers.sort(compareBlocker),
    candidatesInspected,
    placements: placements.sort(comparePlacement),
  });
}

function sourceId(source: PositionSnapshot): string {
  return source.sourceId ?? `missing:${source.roomName}:${String(source.x)}:${String(source.y)}`;
}
function committedOrigin(placements: readonly LayoutPlacement[]): PositionSnapshot | null {
  return (
    placements.find(
      (placement) => placement.layer === "primary" && placement.structureType === "storage",
    )?.pos ??
    placements.find(
      (placement) => placement.layer === "primary" && placement.structureType === "spawn",
    )?.pos ??
    null
  );
}
function adjacent(source: PositionSnapshot): PositionSnapshot[] {
  const candidates: PositionSnapshot[] = [];
  for (let dy = -1; dy <= 1; dy += 1)
    for (let dx = -1; dx <= 1; dx += 1)
      if (dx !== 0 || dy !== 0)
        candidates.push({ roomName: source.roomName, x: source.x + dx, y: source.y + dy });
  return candidates.sort(byPosition);
}
function legalCandidate(input: SourceServicePlanningInput, pos: PositionSnapshot): boolean {
  if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;
  if (input.terrain.cells[pos.y * 50 + pos.x] === "1") return false;
  const primary = input.placements.find(
    (placement) => placement.layer === "primary" && key(placement.pos) === key(pos),
  );
  if (primary !== undefined && primary.structureType !== "container") return false;
  const structures = input.structures.filter((structure) => key(structure.pos) === key(pos));
  if (structures.some((structure) => !walkableType(structure.structureType))) return false;
  const sites = input.constructionSites.filter((site) => key(site.pos) === key(pos));
  return sites.every((site) => walkableType(site.structureType));
}
function rankCandidate(
  input: SourceServicePlanningInput,
  pos: PositionSnapshot,
  origin: PositionSnapshot | null,
): RankedCandidate | null {
  if (origin === null) return null;
  const routeDistance = staticRouteDistance(input, origin, pos);
  if (routeDistance === null) return null;
  const exact = input.structures.some(
    (structure) => structure.structureType === "container" && key(structure.pos) === key(pos),
  );
  const site = input.constructionSites.some(
    (candidate) => candidate.structureType === "container" && key(candidate.pos) === key(pos),
  );
  return {
    adoption: exact ? "exact" : site ? "matching-site" : "planned",
    adoptionRank: exact ? 0 : site ? 1 : 2,
    pos,
    routeDistance,
    terrainRank: input.terrain.cells[pos.y * 50 + pos.x] === "2" ? 1 : 0,
  };
}
function staticRouteDistance(
  input: SourceServicePlanningInput,
  origin: PositionSnapshot,
  goal: PositionSnapshot,
): number | null {
  const blocked = new Set<string>();
  for (let y = 0; y < 50; y += 1)
    for (let x = 0; x < 50; x += 1)
      if (x === 0 || x === 49 || y === 0 || y === 49 || input.terrain.cells[y * 50 + x] === "1")
        blocked.add(`${String(x)},${String(y)}`);
  for (const placement of input.placements)
    if (placement.layer === "primary" && !walkableType(placement.structureType))
      blocked.add(key(placement.pos));
  for (const structure of input.structures)
    if (!walkableType(structure.structureType)) blocked.add(key(structure.pos));
  for (const site of input.constructionSites)
    if (!walkableType(site.structureType)) blocked.add(key(site.pos));
  blocked.delete(key(goal));

  const queue = adjacent(origin)
    .filter((candidate) => !blocked.has(key(candidate)))
    .map((candidate) => ({ distance: 1, pos: candidate }));
  const seen = new Set(queue.map(({ pos }) => key(pos)));
  let inspected = 0;
  while (queue.length > 0 && inspected < MAX_ROUTE_CELLS) {
    const current = queue.shift();
    if (current === undefined) break;
    inspected += 1;
    if (key(current.pos) === key(goal)) return current.distance;
    for (const next of adjacent(current.pos)) {
      const nextKey = key(next);
      if (!blocked.has(nextKey) && !seen.has(nextKey)) {
        seen.add(nextKey);
        queue.push({ distance: current.distance + 1, pos: next });
      }
    }
  }
  return null;
}
function walkableType(structureType: string): boolean {
  return structureType === "container" || structureType === "road" || structureType === "rampart";
}
function blocker(
  sourceId: string,
  pos: PositionSnapshot,
  reason: SourceServiceBlocker["reason"],
): SourceServiceBlocker {
  return { kind: "source-container", pos: plainPosition(pos), reason, sourceId };
}
function plainPosition(pos: PositionSnapshot): PositionSnapshot {
  return { roomName: pos.roomName, x: pos.x, y: pos.y };
}
function compareCandidate(a: RankedCandidate, b: RankedCandidate): number {
  return (
    a.adoptionRank - b.adoptionRank ||
    a.routeDistance - b.routeDistance ||
    a.terrainRank - b.terrainRank ||
    byPosition(a.pos, b.pos)
  );
}
function comparePlacement(a: LayoutPlacement, b: LayoutPlacement): number {
  return compare(a.service?.sourceId ?? "", b.service?.sourceId ?? "") || byPosition(a.pos, b.pos);
}
function compareBlocker(a: SourceServiceBlocker, b: SourceServiceBlocker): number {
  return compare(a.sourceId, b.sourceId) || byPosition(a.pos, b.pos);
}
function byPosition(a: PositionSnapshot, b: PositionSnapshot): number {
  return a.y - b.y || a.x - b.x;
}
function key(pos: PositionSnapshot): string {
  return `${String(pos.x)},${String(pos.y)}`;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
