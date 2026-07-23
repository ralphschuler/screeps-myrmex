import type { ColonyRclUnlockAllowances, ColonyView } from "../colony";
import type { PositionSnapshot, StructureSnapshot } from "../world/snapshot";
import {
  isFutureLayoutAccessWalkable,
  isLayoutAccessWalkableType,
  isLegalSourceWorkCoordinate,
  isObservedLayoutAccessWalkable,
} from "./access";
import { compileOwnedRoomLayoutV1 } from "./layout-v1";
import { selectSourceServices } from "./source-services";
import {
  completedStaleLayoutEvacuationKind,
  LAYOUT_ALGORITHM_REVISION,
  MAX_LAYOUT_CANDIDATES,
  MAX_LAYOUT_FLOOD_CELLS,
  MAX_LAYOUT_ROOMS_PER_TICK,
  MAX_LAYOUT_TRANSFORMS,
  type LayoutBlocker,
  type LayoutCommitment,
  type LayoutPlacement,
  type LayoutPlanningInput,
  type LayoutPlanningResult,
  type LayoutTransform,
  type StaleLayoutRecord,
} from "./contracts";

export function staleLayoutRevisionHandoffBlocker(input: {
  readonly colony: ColonyView;
  readonly record: StaleLayoutRecord;
}): LayoutBlocker | null {
  return staleLayoutRevisionBlocker(input, false);
}

export function staleLayoutRemovalSettlementBlocker(input: {
  readonly colony: ColonyView;
  readonly record: StaleLayoutRecord;
}): LayoutBlocker | null {
  return staleLayoutRevisionBlocker(input, true);
}

function staleLayoutRevisionBlocker(
  input: { readonly colony: ColonyView; readonly record: StaleLayoutRecord },
  allowRemovalReceipt: boolean,
): LayoutBlocker | null {
  const { colony, record } = input;
  const completedEvacuationKind = allowRemovalReceipt
    ? completedStaleLayoutEvacuationKind(record)
    : null;
  if (
    record.algorithmRevision === LAYOUT_ALGORITHM_REVISION ||
    record.containerMigration !== undefined ||
    (record.extensionEvacuation !== undefined && completedEvacuationKind !== "extension") ||
    record.labEvacuation !== undefined ||
    record.linkEvacuation !== undefined ||
    record.spawnEvacuation !== undefined ||
    record.storageEvacuation !== undefined ||
    record.terminalEvacuation !== undefined ||
    (record.towerEvacuation !== undefined && completedEvacuationKind !== "tower") ||
    (!allowRemovalReceipt && record.removalReceipt !== undefined) ||
    (record.siteReceipts?.length ?? 0) > 0 ||
    record.sourceServices?.some(({ service }) => service?.issuerSequence !== undefined) === true
  )
    return "revision-handoff-active";
  if (
    colony.visibility !== "visible" ||
    (colony.state !== "developing" && colony.state !== "mature") ||
    colony.activeThreat !== false ||
    colony.controllerRisk !== false ||
    colony.legalWorkforce !== true ||
    colony.rclPolicy.level === null ||
    colony.rclPolicy.unlocks === null ||
    !colony.rclPolicy.progression.authorized ||
    colony.rclPolicy.protectedSpawnReserve.state !== "restored"
  )
    return "policy-unavailable";
  return null;
}

export function planOwnedRoomLayout(input: LayoutPlanningInput): LayoutPlanningResult {
  if (
    input.terrain.cells.length !== 2_500 ||
    input.policy.unlocks === null ||
    input.policy.level === null
  )
    return degraded(
      input,
      input.policy.unlocks === null ? "policy-unavailable" : "invalid-input",
      0,
      0,
      0,
    );
  if (!hasLegalSourceWorkTile(input)) return degraded(input, "access-blocked", 0, 0, 0);
  const cells = compileOwnedRoomLayoutV1(input.policy.unlocks, input.sources.length);
  const anchors = candidateAnchors(input);
  let transforms = 0;
  let flood = 0;
  let blocker: LayoutBlocker = anchors.length === 0 ? "no-anchor" : "terrain-conflict";
  for (
    let candidate = 0;
    candidate < anchors.length && candidate < MAX_LAYOUT_CANDIDATES;
    candidate += 1
  ) {
    const anchor = anchors[candidate];
    if (anchor === undefined) continue;
    for (let t = 0; t < MAX_LAYOUT_TRANSFORMS; t += 1) {
      transforms += 1;
      const placements = transformCells(input.roomName, anchor, t as LayoutTransform, cells);
      const legal = validatePlacements(input, placements);
      if (!legal.valid) {
        blocker = legal.blocker;
        continue;
      }
      const access = validateAccess(input, placements);
      flood += access.inspected;
      if (!access.valid) {
        blocker = "access-blocked";
        continue;
      }
      const adopted = adopt(placements, input.structures, sourceContainerIds(input));
      let committedAccess = access;
      const plannedSpawn = placements.find(({ structureType }) => structureType === "spawn")?.pos;
      const adoptedSpawn = adopted.find(({ structureType }) => structureType === "spawn")?.pos;
      if (plannedSpawn === undefined || adoptedSpawn === undefined) {
        blocker = "access-blocked";
        continue;
      }
      if (key(plannedSpawn) !== key(adoptedSpawn)) {
        committedAccess = validateAccess(input, adopted);
        flood += committedAccess.inspected;
        if (!committedAccess.valid) {
          blocker = "access-blocked";
          continue;
        }
      }
      const services = selectSourceServices({
        constructionSites: input.constructionSites,
        placements: adopted,
        ...(input.priorSourceServices === undefined
          ? {}
          : { priorSourceServices: input.priorSourceServices }),
        roomName: input.roomName,
        sourceServiceHandoffAuthorized: input.sourceServiceHandoffAuthorized === true,
        sources: input.sources,
        structures: input.structures,
        terrain: input.terrain,
      });
      if (
        services.blockers.length > 0 ||
        services.placements.some(({ pos }) => !committedAccess.reachable.has(key(pos)))
      ) {
        blocker = "access-blocked";
        continue;
      }
      const committedPlacements = mergeSourceServices(adopted, services.placements);
      const fingerprint = hash(
        JSON.stringify({ placements: committedPlacements, blockers: services.blockers }),
      );
      const commitment: LayoutCommitment = {
        algorithmRevision: LAYOUT_ALGORITHM_REVISION,
        anchor,
        blockers: [],
        committedAt: input.tick,
        fingerprint,
        serviceBlockers: services.blockers,
        transform: t as LayoutTransform,
      };
      return freeze({
        status: "complete",
        commitment,
        placements: committedPlacements,
        candidatesInspected: candidate + 1,
        transformsInspected: transforms,
        floodCellsInspected: flood,
      });
    }
  }
  return degraded(
    input,
    anchors.length >= MAX_LAYOUT_CANDIDATES ? "budget-exhausted" : blocker,
    Math.min(anchors.length, MAX_LAYOUT_CANDIDATES),
    transforms,
    flood,
  );
}

export function reconstructCommittedLayout(input: {
  readonly commitment: LayoutCommitment;
  readonly roomName: string;
  readonly sourceCount: number;
  readonly unlocks: ColonyRclUnlockAllowances;
}): readonly LayoutPlacement[] | null {
  if (
    input.commitment.algorithmRevision !== LAYOUT_ALGORITHM_REVISION ||
    !Number.isSafeInteger(input.sourceCount) ||
    input.sourceCount < 0
  ) {
    return null;
  }
  return freeze(
    transformCells(
      input.roomName,
      input.commitment.anchor,
      input.commitment.transform,
      compileOwnedRoomLayoutV1(input.unlocks, input.sourceCount),
    ),
  );
}

export function projectLayoutConvergencePlacements(input: {
  readonly commitment: LayoutCommitment;
  readonly current: readonly LayoutPlacement[];
  readonly roomName: string;
  readonly sourceCount: number;
  readonly sources: readonly PositionSnapshot[];
  readonly unlocks: ColonyRclUnlockAllowances;
}): readonly LayoutPlacement[] {
  const ideal = reconstructCommittedLayout(input);
  if (ideal === null) return input.current;
  const idealGeneralContainers = ideal.filter(
    ({ layer, structureType }) => layer === "primary" && structureType === "container",
  );
  const containerConvergenceSafe =
    input.sources.length === input.sourceCount &&
    idealGeneralContainers.every((placement) =>
      input.sources.every((source) => !inRangeOne(source, placement.pos)),
    );
  const labConvergenceSafe = input.unlocks.labs === 10;
  const spawnConvergenceSafe = input.unlocks.spawns >= 2;
  const storageConvergenceSafe = input.unlocks.storage === 1 && input.unlocks.terminal === 1;
  const terminalConvergenceSafe = input.unlocks.terminal === 1;
  return freeze(
    [
      ...input.current.filter(
        ({ adoption, service, structureType }) =>
          structureType !== "extension" &&
          (structureType !== "lab" || !labConvergenceSafe) &&
          structureType !== "link" &&
          (structureType !== "spawn" || !spawnConvergenceSafe) &&
          (structureType !== "storage" || !storageConvergenceSafe) &&
          (structureType !== "terminal" || !terminalConvergenceSafe) &&
          structureType !== "tower" &&
          (structureType !== "container" ||
            service?.kind === "source-container" ||
            (!containerConvergenceSafe && adoption !== "planned")),
      ),
      ...ideal.filter(
        ({ layer, structureType }) =>
          layer === "primary" &&
          (structureType === "extension" ||
            (structureType === "lab" && labConvergenceSafe) ||
            structureType === "link" ||
            (structureType === "spawn" && spawnConvergenceSafe) ||
            (structureType === "storage" && storageConvergenceSafe) ||
            (structureType === "terminal" && terminalConvergenceSafe) ||
            structureType === "tower" ||
            (structureType === "container" && containerConvergenceSafe)),
      ),
    ].sort(placementOrder),
  );
}

export function selectLayoutPlanningWindow<Value extends { readonly roomName: string }>(
  values: readonly Value[],
  tick: number,
): readonly Value[] {
  const ordered = [...values].sort((left, right) => compare(left.roomName, right.roomName));
  if (ordered.length <= MAX_LAYOUT_ROOMS_PER_TICK) return ordered;
  const start = tick % ordered.length;
  return Array.from({ length: MAX_LAYOUT_ROOMS_PER_TICK }, (_, offset) => {
    const value = ordered[(start + offset) % ordered.length];
    if (value === undefined) throw new Error("layout planning window index escaped its bound");
    return value;
  });
}

export function planOwnedRoomLayouts(
  inputs: readonly LayoutPlanningInput[],
): readonly LayoutPlanningResult[] {
  const tick = inputs.reduce(
    (minimum, input) => Math.min(minimum, input.tick),
    Number.MAX_SAFE_INTEGER,
  );
  return selectLayoutPlanningWindow(inputs, tick).map(planOwnedRoomLayout);
}
function candidateAnchors(input: LayoutPlanningInput): PositionSnapshot[] {
  const spawns = input.structures
    .filter((s) => s.structureType === "spawn" && s.ownership === "owned")
    .sort(byPosition)
    .map((s) => s.pos);
  const generated: PositionSnapshot[] = [];
  for (let y = 9; y <= 40; y += 1)
    for (let x = 9; x <= 40; x += 1)
      if (input.terrain.cells[y * 50 + x] !== "1")
        generated.push({ roomName: input.roomName, x, y });
  generated.sort(
    (a, b) =>
      Math.max(Math.abs(a.x - 25), Math.abs(a.y - 25)) -
        Math.max(Math.abs(b.x - 25), Math.abs(b.y - 25)) || byPosition({ pos: a }, { pos: b }),
  );
  const seen = new Set<string>();
  return [...spawns, ...generated]
    .filter((p) => {
      const positionKey = key(p);
      if (seen.has(positionKey)) return false;
      seen.add(positionKey);
      return true;
    })
    .slice(0, MAX_LAYOUT_CANDIDATES);
}
function transformCells(
  roomName: string,
  anchor: PositionSnapshot,
  transform: LayoutTransform,
  cells: ReturnType<typeof compileOwnedRoomLayoutV1>,
): LayoutPlacement[] {
  return cells
    .map<LayoutPlacement>((cell) => {
      const [dx, dy] = transformOffset(cell.dx, cell.dy, transform);
      return {
        adoption: "planned",
        layer: cell.layer,
        minimumRcl: cell.minimumRcl,
        pos: { roomName, x: anchor.x + dx, y: anchor.y + dy },
        structureType: cell.structureType,
      };
    })
    .sort(placementOrder);
}
function transformOffset(x: number, y: number, t: LayoutTransform): readonly [number, number] {
  const reflected = t >= 4 ? -x : x;
  const r = t % 4;
  return r === 0
    ? [reflected, y]
    : r === 1
      ? [-y, reflected]
      : r === 2
        ? [-reflected, -y]
        : [y, -reflected];
}
function validatePlacements(
  input: LayoutPlanningInput,
  placements: readonly LayoutPlacement[],
): { valid: true } | { valid: false; blocker: LayoutBlocker } {
  const occupied = new Map(input.structures.map((s) => [key(s.pos), s]));
  const sites = new Map(input.constructionSites.map((s) => [key(s.pos), s]));
  const sourcePositions = new Set(input.sources.map(key));
  for (const p of placements) {
    if (sourcePositions.has(key(p.pos))) return { valid: false, blocker: "occupancy-conflict" };
    if (
      p.pos.x < 1 ||
      p.pos.x > 48 ||
      p.pos.y < 1 ||
      p.pos.y > 48 ||
      input.terrain.cells[p.pos.y * 50 + p.pos.x] === "1"
    )
      return { valid: false, blocker: "terrain-conflict" };
    const structure = occupied.get(key(p.pos));
    const site = sites.get(key(p.pos));
    if (
      p.layer === "primary" &&
      ((structure &&
        structure.structureType !== p.structureType &&
        structure.structureType !== "road" &&
        structure.structureType !== "rampart") ||
        (site && site.structureType !== p.structureType))
    )
      return { valid: false, blocker: "occupancy-conflict" };
  }
  return { valid: true };
}
function hasLegalSourceWorkTile(input: LayoutPlanningInput): boolean {
  const blocked = new Set<string>();
  for (const structure of input.structures)
    if (!isObservedLayoutAccessWalkable(structure)) blocked.add(key(structure.pos));
  for (const site of input.constructionSites)
    if (!isFutureLayoutAccessWalkable(site)) blocked.add(key(site.pos));
  return input.sources.every((source) =>
    neighbors(source).some(
      (candidate) =>
        isLegalSourceWorkCoordinate(candidate) &&
        input.terrain.cells[candidate.y * 50 + candidate.x] !== "1" &&
        !blocked.has(key(candidate)),
    ),
  );
}
function validateAccess(
  input: LayoutPlanningInput,
  placements: readonly LayoutPlacement[],
): { valid: boolean; inspected: number; reachable: ReadonlySet<string> } {
  const blocked = new Set(
    placements
      .filter((p) => p.layer === "primary" && !isLayoutAccessWalkableType(p.structureType))
      .map((p) => key(p.pos)),
  );
  for (const structure of input.structures)
    if (!isObservedLayoutAccessWalkable(structure)) blocked.add(key(structure.pos));
  for (const site of input.constructionSites)
    if (!isFutureLayoutAccessWalkable(site)) blocked.add(key(site.pos));
  for (const source of input.sources) blocked.add(key(source));
  const start = placements.find((p) => p.structureType === "spawn")?.pos;
  if (!start) return { valid: false, inspected: 0, reachable: new Set() };
  const queue = neighbors(start).filter((p) => walkable(input, p, blocked));
  const seen = new Set(queue.map(key));
  let inspected = 0;
  while (queue.length > 0 && inspected < MAX_LAYOUT_FLOOD_CELLS) {
    const p = queue.shift();
    if (!p) break;
    inspected += 1;
    for (const n of neighbors(p))
      if (walkable(input, n, blocked) && !seen.has(key(n))) {
        seen.add(key(n));
        queue.push(n);
      }
  }
  const services = [input.controller, ...(input.mineral ? [input.mineral.pos] : [])];
  const serviceOk = services.every((p) => neighbors(p).some((n) => seen.has(key(n))));
  const sourceAccessOk = input.sources.every((source) =>
    neighbors(source).some(
      (candidate) => isLegalSourceWorkCoordinate(candidate) && seen.has(key(candidate)),
    ),
  );
  const exitOk = input.exits.some((p) => neighbors(p).some((n) => seen.has(key(n))));
  const logisticsOk = placements
    .filter((p) => p.structureType === "storage" || p.structureType === "container")
    .every((p) => neighbors(p.pos).some((n) => seen.has(key(n))));
  return {
    valid:
      inspected <= MAX_LAYOUT_FLOOD_CELLS && serviceOk && sourceAccessOk && exitOk && logisticsOk,
    inspected,
    reachable: seen,
  };
}
function adopt(
  placements: readonly LayoutPlacement[],
  structures: readonly StructureSnapshot[],
  reservedStructureIds: ReadonlySet<string>,
): readonly LayoutPlacement[] {
  const exact = new Map(structures.map((s) => [`${s.structureType}:${key(s.pos)}`, s]));
  const external = new Map<string, StructureSnapshot[]>();
  for (const s of [...structures].sort(byPosition)) {
    const list = external.get(s.structureType) ?? [];
    list.push(s);
    external.set(s.structureType, list);
  }
  const used = new Set<string>(reservedStructureIds);
  return placements
    .map((p) => {
      const e = exact.get(`${p.structureType}:${key(p.pos)}`);
      if (e) {
        used.add(e.id);
        return { ...p, adoption: "exact" as const };
      }
      const compatible = external.get(p.structureType)?.find((s) => !used.has(s.id));
      if (compatible && p.layer === "primary") {
        used.add(compatible.id);
        return { ...p, adoption: "compatible-external" as const, pos: compatible.pos };
      }
      return p;
    })
    .sort(placementOrder);
}
function sourceContainerIds(input: LayoutPlanningInput): ReadonlySet<string> {
  const adjacentKeys = new Set(input.sources.flatMap((source) => neighbors(source).map(key)));
  return new Set(
    input.structures
      .filter(
        (structure) =>
          structure.structureType === "container" && adjacentKeys.has(key(structure.pos)),
      )
      .map((structure) => structure.id),
  );
}
function mergeSourceServices(
  placements: readonly LayoutPlacement[],
  services: readonly LayoutPlacement[],
): readonly LayoutPlacement[] {
  const servicePositions = new Set(services.map((placement) => key(placement.pos)));
  return [
    ...placements.filter(
      (placement) =>
        !(placement.structureType === "container" && servicePositions.has(key(placement.pos))),
    ),
    ...services,
  ].sort(placementOrder);
}
function degraded(
  input: LayoutPlanningInput,
  blocker: LayoutBlocker,
  candidatesInspected: number,
  transformsInspected: number,
  floodCellsInspected: number,
): LayoutPlanningResult {
  return freeze({
    status: "degraded",
    blocker,
    commitment:
      input.priorCommitment?.algorithmRevision === LAYOUT_ALGORITHM_REVISION
        ? input.priorCommitment
        : null,
    placements: [] as const,
    candidatesInspected,
    transformsInspected,
    floodCellsInspected,
  });
}
function neighbors(p: PositionSnapshot): PositionSnapshot[] {
  const out: PositionSnapshot[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      if (dx || dy) out.push({ roomName: p.roomName, x: p.x + dx, y: p.y + dy });
  return out;
}
function walkable(i: LayoutPlanningInput, p: PositionSnapshot, b: Set<string>): boolean {
  return (
    p.x >= 0 &&
    p.x < 50 &&
    p.y >= 0 &&
    p.y < 50 &&
    i.terrain.cells[p.y * 50 + p.x] !== "1" &&
    !b.has(key(p))
  );
}
function key(p: PositionSnapshot): string {
  return coordinateKey(p.x, p.y);
}
function inRangeOne(left: PositionSnapshot, right: PositionSnapshot): boolean {
  return (
    left.roomName === right.roomName &&
    Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) <= 1
  );
}
function coordinateKey(x: number, y: number): string {
  return `${String(x)},${String(y)}`;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function byPosition(a: { pos: PositionSnapshot }, b: { pos: PositionSnapshot }): number {
  return a.pos.y - b.pos.y || a.pos.x - b.pos.x;
}
function placementOrder(a: LayoutPlacement, b: LayoutPlacement): number {
  return (
    a.minimumRcl - b.minimumRcl ||
    compare(a.layer, b.layer) ||
    compare(a.structureType, b.structureType) ||
    compare(a.service?.kind ?? "", b.service?.kind ?? "") ||
    compare(a.service?.sourceId ?? "", b.service?.sourceId ?? "") ||
    compare(a.adoption, b.adoption) ||
    a.pos.y - b.pos.y ||
    a.pos.x - b.pos.x
  );
}
function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `layout-v2:${(h >>> 0).toString(36)}`;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
