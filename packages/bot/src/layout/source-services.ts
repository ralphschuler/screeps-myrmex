import type { PositionSnapshot } from "../world/snapshot";
import {
  isFutureLayoutAccessWalkable,
  isLayoutAccessWalkableType,
  isObservedLayoutAccessWalkable,
} from "./access";
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

interface PriorService {
  readonly issuerSequence: number;
  readonly pos: PositionSnapshot;
}

export function selectSourceServices(
  input: SourceServicePlanningInput,
): SourceServicePlanningResult {
  const placements: LayoutPlacement[] = [];
  const blockers: SourceServiceBlocker[] = [];
  const assigned = new Set<string>();
  const priorServices = priorServicePositions(input);
  const reservedPriorPositions = new Set([...priorServices.values()].map(({ pos }) => key(pos)));
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
    const prior = priorServices.get(id);
    const ranked = candidates
      .filter((candidate) => {
        const candidateKey = key(candidate);
        return (
          !assigned.has(candidateKey) &&
          (!reservedPriorPositions.has(candidateKey) ||
            (prior !== undefined && candidateKey === key(prior.pos)))
        );
      })
      .filter((candidate) => legalCandidate(input, candidate))
      .map((candidate) => rankCandidate(input, candidate, origin))
      .filter((candidate): candidate is RankedCandidate => candidate !== null)
      .sort(compareCandidate);
    const priorCandidate =
      prior === undefined ? undefined : ranked.find(({ pos }) => key(pos) === key(prior.pos));
    const exactReplacement = ranked.find(
      ({ adoption, pos }) => adoption === "exact" && key(pos) !== key(prior?.pos ?? pos),
    );
    const handoff =
      input.sourceServiceHandoffAuthorized === true &&
      prior !== undefined &&
      prior.issuerSequence < Number.MAX_SAFE_INTEGER &&
      exactReplacement !== undefined &&
      (priorCandidate === undefined ||
        priorCandidate.adoption === "planned" ||
        (priorCandidate.adoption === "exact" &&
          compareCandidate(exactReplacement, priorCandidate) < 0));
    const selected = handoff ? exactReplacement : (priorCandidate ?? ranked[0]);
    if (selected === undefined) {
      blockers.push(blocker(id, source, "no-legal-position"));
      continue;
    }
    assigned.add(key(selected.pos));
    const issuerSequence = handoff
      ? prior.issuerSequence + 1
      : prior !== undefined && key(selected.pos) === key(prior.pos)
        ? prior.issuerSequence
        : 1;
    placements.push({
      adoption: selected.adoption,
      layer: "primary",
      minimumRcl: 2,
      pos: selected.pos,
      service: {
        ...(issuerSequence === 1 ? {} : { issuerSequence }),
        kind: "source-container",
        sourceId: id,
      },
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
function priorServicePositions(
  input: SourceServicePlanningInput,
): ReadonlyMap<string, PriorService> {
  const prior = input.priorSourceServices;
  if (prior === undefined || prior.length > 8) return new Map();
  const positions = new Map<string, PriorService>();
  const assigned = new Set<string>();
  for (const placement of prior) {
    const sourceId = placement.service?.sourceId;
    if (
      placement.layer !== "primary" ||
      placement.structureType !== "container" ||
      placement.service?.kind !== "source-container" ||
      sourceId === undefined ||
      sourceId.length === 0 ||
      sourceId.length > 128 ||
      (placement.service.issuerSequence !== undefined &&
        (!Number.isSafeInteger(placement.service.issuerSequence) ||
          placement.service.issuerSequence < 2)) ||
      placement.pos.roomName !== input.roomName ||
      !coordinate(placement.pos.x) ||
      !coordinate(placement.pos.y) ||
      positions.has(sourceId) ||
      assigned.has(key(placement.pos))
    )
      return new Map();
    positions.set(sourceId, {
      issuerSequence: placement.service.issuerSequence ?? 1,
      pos: placement.pos,
    });
    assigned.add(key(placement.pos));
  }
  return positions;
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
  if (input.sources.some((source) => key(source) === key(pos))) return false;
  const primary = input.placements.find(
    (placement) => placement.layer === "primary" && key(placement.pos) === key(pos),
  );
  if (primary !== undefined && primary.structureType !== "container") return false;
  const structures = input.structures.filter((structure) => key(structure.pos) === key(pos));
  if (structures.some((structure) => !isObservedLayoutAccessWalkable(structure))) return false;
  const sites = input.constructionSites.filter((site) => key(site.pos) === key(pos));
  return sites.every(isFutureLayoutAccessWalkable);
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
    if (placement.layer === "primary" && !isLayoutAccessWalkableType(placement.structureType))
      blocked.add(key(placement.pos));
  for (const structure of input.structures)
    if (!isObservedLayoutAccessWalkable(structure)) blocked.add(key(structure.pos));
  for (const site of input.constructionSites)
    if (!isFutureLayoutAccessWalkable(site)) blocked.add(key(site.pos));
  for (const source of input.sources) blocked.add(key(source));
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
function coordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 50;
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
