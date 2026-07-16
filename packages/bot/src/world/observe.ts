import type { RuntimeGame } from "../runtime/context";
import {
  freezeWorldSnapshot,
  utf8ByteLength,
  WORLD_SNAPSHOT_SCHEMA_VERSION,
  type BodyCapabilitiesSnapshot,
  type BodyPartCapabilitySnapshot,
  type ConstructionSiteSnapshot,
  type ControllerSnapshot,
  type CreepSnapshot,
  type DroppedResourceSnapshot,
  type OwnedExtensionSnapshot,
  type OwnedRoomSnapshot,
  type OwnedSpawnSnapshot,
  type OwnedTowerSnapshot,
  type PositionSnapshot,
  type RoomSnapshot,
  type RoomVisibilitySnapshot,
  type RoadSnapshot,
  type RuinSnapshot,
  type SnapshotEntityCounts,
  type SourceSnapshot,
  type StoredStructureSnapshot,
  type StoreSnapshot,
  type TombstoneSnapshot,
  type WorldSnapshot,
} from "./snapshot";

const MAX_CREEP_BODY_PARTS = 50;
const BODY_PART_TYPES = [
  "move",
  "work",
  "carry",
  "attack",
  "ranged_attack",
  "heal",
  "claim",
  "tough",
] as const satisfies readonly BodyPartConstant[];

type SnapshotBodyPart = (typeof BODY_PART_TYPES)[number];
type MutableBodyPartCount = { active: number; boosted: number; total: number };

interface StoreLike {
  getCapacity?(resource?: ResourceConstant): number | null;
  getFreeCapacity?(resource?: ResourceConstant): number | null;
  getUsedCapacity?(resource?: ResourceConstant): number | null;
}

export interface ObserveWorldOptions {
  /**
   * Names whose visibility a caller needs to distinguish explicitly. Missing requested rooms are
   * represented as unknown; no historical snapshot is consulted.
   */
  readonly requestedRoomNames?: readonly string[];
}

export function observeWorld(game: RuntimeGame, options: ObserveWorldOptions = {}): WorldSnapshot {
  const ownedCreepsByRoom = groupOwnedCreeps(game);
  const rooms = Object.values(game.rooms)
    .map((room) => observeRoom(room, game.time, ownedCreepsByRoom.get(room.name) ?? []))
    .sort(compareByName);
  const ownedRooms = rooms.filter(isOwnedRoomSnapshot);
  const visibility = buildVisibility(rooms, options.requestedRoomNames ?? [], game.time);
  const entities = countEntities(rooms);
  const payload = {
    observation: {
      age: 0 as const,
      shard: game.shard.name,
      status: "observed" as const,
      tick: game.time,
    },
    observedAt: game.time,
    ownedRooms,
    rooms,
    schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    visibility: {
      absentRoomSemantics: "unknown" as const,
      rooms: visibility,
      scope: "current-tick" as const,
    },
  };

  return freezeWorldSnapshot({
    ...payload,
    stats: {
      entities,
      estimatedPayloadBytes: utf8ByteLength(JSON.stringify(payload)),
    },
  });
}

function observeRoom(room: Room, observedAt: number, ownedCreeps: readonly Creep[]): RoomSnapshot {
  const structures = room.find(FIND_STRUCTURES);
  const creeps = room.find(FIND_CREEPS);
  const constructionSites = room.find(FIND_CONSTRUCTION_SITES);
  const droppedResources =
    typeof FIND_DROPPED_RESOURCES === "undefined" ? [] : room.find(FIND_DROPPED_RESOURCES);
  const ruins = typeof FIND_RUINS === "undefined" ? [] : room.find(FIND_RUINS);
  const tombstones = typeof FIND_TOMBSTONES === "undefined" ? [] : room.find(FIND_TOMBSTONES);
  const traversal = snapshotTraversal(room, structures, constructionSites);

  return {
    constructionSites: constructionSites.map(snapshotConstructionSite).sort(compareById),
    controller: room.controller === undefined ? null : snapshotController(room.controller),
    energyAvailable: room.energyAvailable,
    energyCapacityAvailable: room.energyCapacityAvailable,
    droppedResources: droppedResources.map(snapshotDroppedResource).sort(compareById),
    hostileCreeps: creeps
      .filter((creep) => !creep.my)
      .map(snapshotCreep)
      .sort(compareById),
    name: room.name,
    observedAt,
    ownedCreeps: ownedCreeps.map(snapshotCreep).sort(compareById),
    ownedExtensions: structures
      .filter((structure) => isMyStructureOfType(structure, "extension"))
      .map((structure) => snapshotExtension(structure as StructureExtension))
      .sort(compareById),
    ownedSpawns: structures
      .filter((structure) => isMyStructureOfType(structure, "spawn"))
      .map((structure) => snapshotSpawn(structure as StructureSpawn))
      .sort(compareById),
    ownedTowers: structures
      .filter((structure) => isMyStructureOfType(structure, "tower"))
      .map((structure) => snapshotTower(structure as StructureTower))
      .sort(compareById),
    roads: structures
      .filter((structure) => structure.structureType === "road")
      .map(snapshotRoad)
      .sort(compareById),
    ruins: ruins.map(snapshotRuin).sort(compareById),
    sources: room.find(FIND_SOURCES).map(snapshotSource).sort(compareById),
    storedStructures: structures.filter(hasStore).map(snapshotStoredStructure).sort(compareById),
    tombstones: tombstones.map(snapshotTombstone).sort(compareById),
    ...(traversal === undefined ? {} : { traversal }),
  };
}

function snapshotRoad(road: StructureRoad): RoadSnapshot {
  return {
    hits: road.hits,
    hitsMax: road.hitsMax,
    id: String(road.id),
    pos: snapshotPosition(road.pos),
    ticksToDecay: nullableNumber(road.ticksToDecay),
  };
}

function groupOwnedCreeps(game: RuntimeGame): ReadonlyMap<string, readonly Creep[]> {
  const grouped = new Map<string, Creep[]>();
  const seenIds = new Set<string>();
  for (const [name, creep] of Object.entries(game.creeps).sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    if (creep.name !== name) {
      throw new Error("Game.creeps key does not match the owned creep name");
    }
    if (!creep.my) {
      throw new Error("Game.creeps contains a creep not owned by the player");
    }
    const id = String(creep.id);
    if (seenIds.has(id)) {
      throw new Error("Game.creeps contains a duplicate owned creep id");
    }
    seenIds.add(id);
    const roomName = creep.pos.roomName;
    if (game.rooms[roomName] === undefined) {
      throw new Error("Game.creeps contains an owned creep outside the visible room set");
    }
    const roomCreeps = grouped.get(roomName) ?? [];
    roomCreeps.push(creep);
    grouped.set(roomName, roomCreeps);
  }

  return grouped;
}

function snapshotController(controller: StructureController): ControllerSnapshot {
  const ownerUsername = controller.owner?.username ?? null;
  const reservationUsername = controller.reservation?.username ?? null;

  return {
    id: String(controller.id),
    level: controller.level,
    ownerUsername,
    ownership: controller.my
      ? "owned"
      : ownerUsername !== null
        ? "foreign"
        : reservationUsername !== null
          ? "reserved"
          : "neutral",
    pos: snapshotPosition(controller.pos),
    progress: nullableNumber(controller.progress),
    progressTotal: nullableNumber(controller.progressTotal),
    reservationTicksToEnd: nullableNumber(controller.reservation?.ticksToEnd),
    reservationUsername,
    safeMode: nullableNumber(controller.safeMode),
    safeModeAvailable: controller.safeModeAvailable,
    safeModeCooldown: nullableNumber(controller.safeModeCooldown),
    ticksToDowngrade: nullableNumber(controller.ticksToDowngrade),
    upgradeBlocked: nullableNumber(controller.upgradeBlocked),
  };
}

function snapshotSource(source: Source): SourceSnapshot {
  return {
    energy: source.energy,
    energyCapacity: source.energyCapacity,
    id: String(source.id),
    pos: snapshotPosition(source.pos),
    ticksToRegeneration: nullableNumber(source.ticksToRegeneration),
  };
}

function snapshotSpawn(spawn: StructureSpawn): OwnedSpawnSnapshot {
  return {
    active: spawn.isActive(),
    hits: spawn.hits,
    hitsMax: spawn.hitsMax,
    id: String(spawn.id),
    name: spawn.name,
    pos: snapshotPosition(spawn.pos),
    spawning:
      spawn.spawning === null
        ? null
        : {
            creepName: spawn.spawning.name,
            needTime: spawn.spawning.needTime,
            remainingTime: spawn.spawning.remainingTime,
          },
    store: snapshotStore(spawn.store),
  };
}

function snapshotExtension(extension: StructureExtension): OwnedExtensionSnapshot {
  return {
    hits: extension.hits,
    hitsMax: extension.hitsMax,
    id: String(extension.id),
    pos: snapshotPosition(extension.pos),
    store: snapshotStore(extension.store),
  };
}

function snapshotTower(tower: StructureTower): OwnedTowerSnapshot {
  return {
    hits: tower.hits,
    hitsMax: tower.hitsMax,
    id: String(tower.id),
    pos: snapshotPosition(tower.pos),
    store: snapshotStore(tower.store),
  };
}

function snapshotStoredStructure(
  structure: AnyStructure & { readonly store: StoreLike },
): StoredStructureSnapshot {
  const ownership = structureOwnership(structure);
  const owned = structure as unknown as { readonly owner?: { readonly username: string } };

  return {
    hits: structure.hits,
    hitsMax: structure.hitsMax,
    id: String(structure.id),
    ownerUsername: owned.owner?.username ?? null,
    ownership,
    pos: snapshotPosition(structure.pos),
    store: snapshotStore(structure.store),
    structureType: structure.structureType,
  };
}

function snapshotConstructionSite(site: ConstructionSite): ConstructionSiteSnapshot {
  return {
    id: String(site.id),
    ownerUsername: site.owner.username,
    ownership: site.my ? "owned" : "foreign",
    pos: snapshotPosition(site.pos),
    progress: site.progress,
    progressTotal: site.progressTotal,
    structureType: site.structureType,
  };
}

function snapshotDroppedResource(resource: Resource): DroppedResourceSnapshot {
  return {
    amount: resource.amount,
    id: String(resource.id),
    pos: snapshotPosition(resource.pos),
    resourceType: resource.resourceType,
  };
}

function snapshotTombstone(tombstone: Tombstone): TombstoneSnapshot {
  return {
    id: String(tombstone.id),
    pos: snapshotPosition(tombstone.pos),
    store: snapshotStore(tombstone.store),
  };
}

function snapshotRuin(ruin: Ruin): RuinSnapshot {
  return { id: String(ruin.id), pos: snapshotPosition(ruin.pos), store: snapshotStore(ruin.store) };
}

function snapshotCreep(creep: Creep): CreepSnapshot {
  return {
    body: snapshotBody(creep.body),
    fatigue: creep.fatigue,
    hits: creep.hits,
    hitsMax: creep.hitsMax,
    id: String(creep.id),
    name: creep.name,
    ownerUsername: creep.owner.username,
    pos: snapshotPosition(creep.pos),
    spawning: creep.spawning,
    store: snapshotStore(creep.store),
    ticksToLive: nullableNumber(creep.ticksToLive),
  };
}

function snapshotBody(body: readonly BodyPartDefinition[]): BodyCapabilitiesSnapshot {
  const counts = Object.fromEntries(
    BODY_PART_TYPES.map((part) => [part, { active: 0, boosted: 0, total: 0 }]),
  ) as Record<SnapshotBodyPart, MutableBodyPartCount>;
  const size = Math.min(body.length, MAX_CREEP_BODY_PARTS);

  for (let index = 0; index < size; index += 1) {
    const part = body[index];
    if (part === undefined) {
      continue;
    }

    const count = counts[part.type];
    count.total += 1;
    if (part.hits > 0) {
      count.active += 1;
    }
    if (part.boost !== undefined) {
      count.boosted += 1;
    }
  }

  return {
    activeParts: BODY_PART_TYPES.reduce((total, part) => total + counts[part].active, 0),
    attack: copyBodyPartCount(counts.attack),
    carry: copyBodyPartCount(counts.carry),
    claim: copyBodyPartCount(counts.claim),
    heal: copyBodyPartCount(counts.heal),
    move: copyBodyPartCount(counts.move),
    rangedAttack: copyBodyPartCount(counts.ranged_attack),
    size,
    tough: copyBodyPartCount(counts.tough),
    work: copyBodyPartCount(counts.work),
  };
}

function copyBodyPartCount(count: MutableBodyPartCount): BodyPartCapabilitySnapshot {
  return { active: count.active, boosted: count.boosted, total: count.total };
}

function snapshotStore(store: StoreLike): StoreSnapshot {
  const values = store as Record<string, unknown>;
  const resources = Object.keys(values)
    .filter((resourceType) => typeof values[resourceType] === "number")
    .map((resourceType) => ({
      amount: values[resourceType] as number,
      resourceType,
    }))
    .sort(compareByResourceType);
  const calculatedUsed = resources.reduce((total, resource) => total + resource.amount, 0);

  return {
    capacity: callStoreMethod(store, "getCapacity"),
    freeCapacity: callStoreMethod(store, "getFreeCapacity"),
    resources,
    usedCapacity: callStoreMethod(store, "getUsedCapacity") ?? calculatedUsed,
  };
}

function callStoreMethod(
  store: StoreLike,
  method: "getCapacity" | "getFreeCapacity" | "getUsedCapacity",
): number | null {
  const candidate = store[method];
  if (candidate === undefined) {
    return null;
  }

  return candidate.call(store) ?? null;
}

function snapshotPosition(position: RoomPosition): PositionSnapshot {
  return {
    roomName: position.roomName,
    x: position.x,
    y: position.y,
  };
}

/**
 * This is the only Observe-phase read of Room terrain. The compact detached projection deliberately
 * excludes creeps and reservations; the movement arbiter overlays those current-tick facts later.
 */
function snapshotTraversal(
  room: Room,
  structures: readonly AnyStructure[],
  constructionSites: readonly ConstructionSite[],
): { readonly revision: string; readonly walkability: string } | undefined {
  if (typeof room.getTerrain !== "function") return undefined;
  let terrainView: RoomTerrain;
  try {
    terrainView = room.getTerrain();
  } catch {
    return undefined;
  }
  const blocked = new Set<number>();
  for (const structure of structures) {
    if (!isStaticallyWalkable(structure.structureType)) {
      blocked.add(positionIndex(structure.pos.x, structure.pos.y));
    }
  }
  for (const site of constructionSites) {
    if (!isStaticallyWalkable(site.structureType)) {
      blocked.add(positionIndex(site.pos.x, site.pos.y));
    }
  }
  const cells: string[] = [];
  for (let y = 0; y < 50; y += 1) {
    for (let x = 0; x < 50; x += 1) {
      const terrainCell = terrainView.get(x, y);
      cells.push((terrainCell & 1) !== 0 || blocked.has(positionIndex(x, y)) ? "#" : ".");
    }
  }
  const walkability = cells.join("");
  return { revision: traversalRevision(walkability), walkability };
}

function isStaticallyWalkable(structureType: string): boolean {
  return structureType === "container" || structureType === "rampart" || structureType === "road";
}

function positionIndex(x: number, y: number): number {
  return y * 50 + x;
}

function traversalRevision(walkability: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < walkability.length; index += 1) {
    hash ^= walkability.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `traversal-v1:${(hash >>> 0).toString(36)}`;
}

function buildVisibility(
  rooms: readonly RoomSnapshot[],
  requestedRoomNames: readonly string[],
  observedAt: number,
): RoomVisibilitySnapshot[] {
  const visibleNames = new Set(rooms.map((room) => room.name));
  const names = new Set([...visibleNames, ...requestedRoomNames]);

  return [...names]
    .sort(compareStrings)
    .map((roomName) =>
      visibleNames.has(roomName)
        ? { age: 0, observedAt, roomName, status: "visible" }
        : { age: null, observedAt: null, roomName, status: "unknown" },
    );
}

function countEntities(rooms: readonly RoomSnapshot[]): SnapshotEntityCounts {
  const counts = {
    constructionSites: sum(rooms, (room) => room.constructionSites.length),
    controllers: sum(rooms, (room) => (room.controller === null ? 0 : 1)),
    droppedResources: sum(rooms, (room) => room.droppedResources?.length ?? 0),
    hostileCreeps: sum(rooms, (room) => room.hostileCreeps.length),
    ownedCreeps: sum(rooms, (room) => room.ownedCreeps.length),
    ownedExtensions: sum(rooms, (room) => room.ownedExtensions.length),
    ownedSpawns: sum(rooms, (room) => room.ownedSpawns.length),
    ownedTowers: sum(rooms, (room) => room.ownedTowers.length),
    rooms: rooms.length,
    ruins: sum(rooms, (room) => room.ruins?.length ?? 0),
    sources: sum(rooms, (room) => room.sources.length),
    storedStructures: sum(rooms, (room) => room.storedStructures.length),
    tombstones: sum(rooms, (room) => room.tombstones?.length ?? 0),
  };

  return {
    ...counts,
    total:
      counts.rooms +
      counts.controllers +
      counts.droppedResources +
      counts.sources +
      counts.storedStructures +
      counts.ruins +
      counts.tombstones +
      counts.constructionSites +
      counts.ownedCreeps +
      counts.hostileCreeps,
  };
}

function sum(rooms: readonly RoomSnapshot[], count: (room: RoomSnapshot) => number): number {
  return rooms.reduce((total, room) => total + count(room), 0);
}

function isOwnedRoomSnapshot(room: RoomSnapshot): room is OwnedRoomSnapshot {
  return room.controller?.ownership === "owned";
}

function isMyStructureOfType(structure: Structure, structureType: StructureConstant): boolean {
  return structure.structureType === structureType && "my" in structure && structure.my === true;
}

function hasStore(
  structure: AnyStructure,
): structure is AnyStructure & { readonly store: StoreLike } {
  return "store" in structure;
}

function structureOwnership(structure: AnyStructure): "owned" | "foreign" | "unowned" {
  const owned = structure as unknown as { readonly my?: boolean };
  if (owned.my === undefined) {
    return "unowned";
  }

  return owned.my ? "owned" : "foreign";
}

function nullableNumber(value: number | undefined): number | null {
  return value ?? null;
}

function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareStrings(left.id, right.id);
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return compareStrings(left.name, right.name);
}

function compareByResourceType(
  left: { readonly resourceType: string },
  right: { readonly resourceType: string },
): number {
  return compareStrings(left.resourceType, right.resourceType);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
