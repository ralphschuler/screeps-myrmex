import type {
  PositionSnapshot,
  RoomSnapshot,
  StoreSnapshot,
  StoredStructureSnapshot,
} from "../world/snapshot";
import { MAX_LOGISTICS_NODES } from "./planner";
import type { LogisticsNode, LogisticsPriority } from "./planner";

export const MAX_LOGISTICS_OBSERVED_ROOMS = 32;
export const MAX_LOGISTICS_OBSERVATION_BLOCKERS = 256;
export const CONTROLLER_SUPPLY_PROXY_CAPACITY = 50;

export type LogisticsObservationBlockerReason =
  | "blocker-cap"
  | "collection-unobserved"
  | "duplicate-room"
  | "empty-store"
  | "full-store"
  | "inactive-structure"
  | "node-cap"
  | "room-cap"
  | "room-not-owned"
  | "room-stale"
  | "room-unobserved"
  | "unknown-capacity";

export interface LogisticsObservationBlocker {
  readonly id: string;
  readonly reason: LogisticsObservationBlockerReason;
}

export interface LogisticsObservationInput {
  /** Current visible room facts. Missing expected colonies fail closed as unobserved. */
  readonly rooms: readonly RoomSnapshot[];
  readonly tick: number;
  readonly expectedColonyIds?: readonly string[];
}

export interface LogisticsObservation {
  readonly nodes: readonly LogisticsNode[];
  readonly blockers: readonly LogisticsObservationBlocker[];
}

const GENERAL_STORE_TYPES = new Set([
  "container",
  "factory",
  "lab",
  "link",
  "nuker",
  "powerSpawn",
  "storage",
  "terminal",
]);

/** Pure fail-closed adapter from detached current-tick room facts to planner nodes. */
export function observeLogistics(input: LogisticsObservationInput): LogisticsObservation {
  const blockers: LogisticsObservationBlocker[] = [];
  const candidates: LogisticsNode[] = [];
  const roomCounts = countRoomNames(input.rooms);
  const roomsByName = new Map(
    [...input.rooms]
      .sort((left, right) => left.name.localeCompare(right.name))
      .filter((room) => (roomCounts.get(room.name) ?? 0) === 1)
      .map((room) => [room.name, room]),
  );
  for (const [roomName, count] of [...roomCounts].sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    if (count > 1) blockers.push({ id: `room/${roomName}`, reason: "duplicate-room" });

  const expected = [...new Set(input.expectedColonyIds ?? [...roomsByName.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );
  for (const roomName of expected.slice(MAX_LOGISTICS_OBSERVED_ROOMS))
    blockers.push({ id: `room/${roomName}`, reason: "room-cap" });

  for (const roomName of expected.slice(0, MAX_LOGISTICS_OBSERVED_ROOMS)) {
    const room = roomsByName.get(roomName);
    if (room === undefined) {
      blockers.push({ id: `room/${roomName}`, reason: "room-unobserved" });
      continue;
    }
    if (room.observedAt !== input.tick) {
      blockers.push({ id: `room/${roomName}`, reason: "room-stale" });
      continue;
    }
    if (room.controller?.ownership !== "owned") {
      blockers.push({ id: `room/${roomName}`, reason: "room-not-owned" });
      continue;
    }
    observeOwnedRoom(room, input.tick, candidates, blockers);
  }

  candidates.sort((left, right) => left.id.localeCompare(right.id));
  for (const candidate of candidates.slice(MAX_LOGISTICS_NODES))
    blockers.push({ id: candidate.id, reason: "node-cap" });
  return freeze({
    nodes: candidates.slice(0, MAX_LOGISTICS_NODES),
    blockers: boundedBlockers(blockers),
  });
}

function observeOwnedRoom(
  room: RoomSnapshot,
  tick: number,
  nodes: LogisticsNode[],
  blockers: LogisticsObservationBlocker[],
): void {
  const controller = room.controller;
  if (controller === null) return;
  const specializedIds = new Set<string>();
  for (const spawn of [...room.ownedSpawns].sort(byId)) {
    specializedIds.add(spawn.id);
    observeEnergySink(
      room.name,
      `spawn/${spawn.id}`,
      spawn.pos,
      spawn.store,
      spawn.active,
      tick,
      nodes,
      blockers,
    );
  }
  for (const extension of [...room.ownedExtensions].sort(byId)) {
    specializedIds.add(extension.id);
    observeEnergySink(
      room.name,
      `extension/${extension.id}`,
      extension.pos,
      extension.store,
      extension.active,
      tick,
      nodes,
      blockers,
    );
  }
  for (const tower of [...room.ownedTowers].sort(byId)) {
    specializedIds.add(tower.id);
    observeEnergySink(
      room.name,
      `tower/${tower.id}`,
      tower.pos,
      tower.store,
      true,
      tick,
      nodes,
      blockers,
    );
  }

  nodes.push(
    logisticsNode({
      id: `controller/${room.name}/energy`,
      colonyId: room.name,
      resourceType: "energy",
      kind: "sink",
      observedAmount: 0,
      freeCapacity: CONTROLLER_SUPPLY_PROXY_CAPACITY,
      observedAt: tick,
      priority: mandatory(tick + 50),
      position: controller.pos,
    }),
  );

  for (const structure of [...room.storedStructures].sort(byId)) {
    if (specializedIds.has(structure.id) || !GENERAL_STORE_TYPES.has(structure.structureType))
      continue;
    observeStoredStructure(room.name, structure, tick, nodes, blockers);
  }
  observeLooseStores(room.name, "drop", room.droppedResources, tick, nodes, blockers);
  observeLooseStores(room.name, "tombstone", room.tombstones, tick, nodes, blockers);
  observeLooseStores(room.name, "ruin", room.ruins, tick, nodes, blockers);
}

function observeEnergySink(
  colonyId: string,
  identity: string,
  position: PositionSnapshot,
  store: StoreSnapshot,
  active: boolean,
  tick: number,
  nodes: LogisticsNode[],
  blockers: LogisticsObservationBlocker[],
): void {
  const id = `${identity}/energy`;
  if (!active) {
    blockers.push({ id, reason: "inactive-structure" });
    return;
  }
  if (store.freeCapacity === null) {
    blockers.push({ id, reason: "unknown-capacity" });
    return;
  }
  if (store.freeCapacity === 0) {
    blockers.push({ id, reason: "full-store" });
    return;
  }
  nodes.push(
    logisticsNode({
      id,
      colonyId,
      resourceType: "energy",
      kind: "sink",
      observedAmount: resourceAmount(store, "energy"),
      freeCapacity: store.freeCapacity,
      observedAt: tick,
      priority: mandatory(tick),
      position,
    }),
  );
}

function observeStoredStructure(
  colonyId: string,
  structure: StoredStructureSnapshot,
  tick: number,
  nodes: LogisticsNode[],
  blockers: LogisticsObservationBlocker[],
): void {
  const prefix = `${structure.structureType}/${structure.id}`;
  const resources = [...structure.store.resources].sort((left, right) =>
    left.resourceType.localeCompare(right.resourceType),
  );
  if (resources.length === 0 || resources.every((resource) => resource.amount === 0))
    blockers.push({ id: prefix, reason: "empty-store" });

  const energy = resourceAmount(structure.store, "energy");
  const reserveBuffer =
    structure.structureType === "storage" || structure.structureType === "terminal";
  if (reserveBuffer && structure.store.freeCapacity === null)
    blockers.push({ id: `${prefix}/energy`, reason: "unknown-capacity" });
  if (reserveBuffer && structure.store.freeCapacity === 0)
    blockers.push({ id: `${prefix}/energy`, reason: "full-store" });
  if (reserveBuffer && structure.store.freeCapacity !== null && structure.store.freeCapacity > 0) {
    nodes.push(
      logisticsNode({
        id: `${prefix}/energy`,
        colonyId,
        resourceType: "energy",
        kind: "buffer",
        observedAmount: energy,
        freeCapacity: structure.store.freeCapacity,
        observedAt: tick,
        priority: normal(tick + 1_000),
        position: structure.pos,
      }),
    );
  }
  for (const resource of resources) {
    if (resource.amount <= 0 || (reserveBuffer && resource.resourceType === "energy")) continue;
    nodes.push(
      logisticsNode({
        id: `${prefix}/${resource.resourceType}`,
        colonyId,
        resourceType: resource.resourceType,
        kind: "source",
        observedAmount: resource.amount,
        freeCapacity: 0,
        observedAt: tick,
        priority: normal(Number.MAX_SAFE_INTEGER),
        position: structure.pos,
      }),
    );
  }
}

function observeLooseStores(
  colonyId: string,
  kind: "drop" | "ruin" | "tombstone",
  values: readonly { readonly id: string; readonly pos: PositionSnapshot }[] | undefined,
  tick: number,
  nodes: LogisticsNode[],
  blockers: LogisticsObservationBlocker[],
): void {
  if (values === undefined) {
    blockers.push({ id: `room/${colonyId}/${kind}`, reason: "collection-unobserved" });
    return;
  }
  for (const value of [...values].sort(byId)) {
    if (kind === "drop") {
      const dropped = value as typeof value & {
        readonly amount: number;
        readonly resourceType: string;
      };
      if (dropped.amount > 0)
        nodes.push(
          sourceNode(
            colonyId,
            `${kind}/${dropped.id}`,
            dropped.resourceType,
            dropped.amount,
            tick,
            dropped.pos,
          ),
        );
      continue;
    }
    const stored = value as typeof value & { readonly store: StoreSnapshot };
    if (stored.store.resources.length === 0)
      blockers.push({ id: `${kind}/${stored.id}`, reason: "empty-store" });
    for (const resource of [...stored.store.resources].sort((left, right) =>
      left.resourceType.localeCompare(right.resourceType),
    ))
      if (resource.amount > 0)
        nodes.push(
          sourceNode(
            colonyId,
            `${kind}/${stored.id}`,
            resource.resourceType,
            resource.amount,
            tick,
            stored.pos,
          ),
        );
  }
}

function sourceNode(
  colonyId: string,
  identity: string,
  resourceType: string,
  amount: number,
  tick: number,
  position: PositionSnapshot,
): LogisticsNode {
  return logisticsNode({
    id: `${identity}/${resourceType}`,
    colonyId,
    resourceType,
    kind: "source",
    observedAmount: amount,
    freeCapacity: 0,
    observedAt: tick,
    priority: normal(Number.MAX_SAFE_INTEGER),
    position,
  });
}

function logisticsNode(node: LogisticsNode): LogisticsNode {
  return node;
}

function resourceAmount(store: StoreSnapshot, resourceType: string): number {
  return store.resources.find((resource) => resource.resourceType === resourceType)?.amount ?? 0;
}

function mandatory(deadline: number): LogisticsPriority {
  return { class: "mandatory", deadline };
}

function normal(deadline: number): LogisticsPriority {
  return { class: "normal", deadline };
}

function countRoomNames(rooms: readonly RoomSnapshot[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const room of rooms) counts.set(room.name, (counts.get(room.name) ?? 0) + 1);
  return counts;
}

function boundedBlockers(
  blockers: readonly LogisticsObservationBlocker[],
): readonly LogisticsObservationBlocker[] {
  const canonical = [...blockers].sort(
    (left, right) => left.id.localeCompare(right.id) || left.reason.localeCompare(right.reason),
  );
  if (canonical.length <= MAX_LOGISTICS_OBSERVATION_BLOCKERS) return canonical;
  return [
    ...canonical.slice(0, MAX_LOGISTICS_OBSERVATION_BLOCKERS - 1),
    { id: "observation/blockers", reason: "blocker-cap" as const },
  ].sort(
    (left, right) => left.id.localeCompare(right.id) || left.reason.localeCompare(right.reason),
  );
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
