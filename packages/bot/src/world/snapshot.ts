export const WORLD_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SnapshotObservationStatus = "observed" | "empty";
export type RoomVisibilityStatus = "visible" | "unknown";
export type ControllerOwnership = "owned" | "foreign" | "reserved" | "neutral";

export interface PositionSnapshot {
  readonly roomName: string;
  /** Present only when this position is the detached position of a Source. */
  readonly sourceId?: string;
  readonly x: number;
  readonly y: number;
}

export interface StoreResourceSnapshot {
  readonly amount: number;
  readonly resourceType: string;
}

export interface StoreSnapshot {
  readonly capacity: number | null;
  readonly freeCapacity: number | null;
  readonly resources: readonly StoreResourceSnapshot[];
  readonly usedCapacity: number;
}

export interface BodyPartCapabilitySnapshot {
  readonly active: number;
  readonly boosted: number;
  readonly total: number;
}

/**
 * Fixed-width aggregate of a creep body. It deliberately does not retain the live body array and
 * stays bounded even when the game object contains the maximum 50 body parts.
 */
export interface BodyCapabilitiesSnapshot {
  readonly activeParts: number;
  readonly attack: BodyPartCapabilitySnapshot;
  readonly carry: BodyPartCapabilitySnapshot;
  readonly claim: BodyPartCapabilitySnapshot;
  readonly heal: BodyPartCapabilitySnapshot;
  readonly move: BodyPartCapabilitySnapshot;
  readonly rangedAttack: BodyPartCapabilitySnapshot;
  readonly size: number;
  readonly tough: BodyPartCapabilitySnapshot;
  readonly work: BodyPartCapabilitySnapshot;
}

/** Exact bounded boost evidence retained only for currently boosted body parts. */
export interface CreepBoostSnapshot {
  readonly bodyPart: BodyPartConstant;
  readonly compound: string;
  readonly count: number;
}

export interface ControllerSnapshot {
  readonly id: string;
  readonly level: number;
  readonly ownerUsername: string | null;
  readonly ownership: ControllerOwnership;
  readonly pos: PositionSnapshot;
  readonly progress: number | null;
  readonly progressTotal: number | null;
  readonly reservationTicksToEnd: number | null;
  readonly reservationUsername: string | null;
  readonly safeMode: number | null;
  readonly safeModeAvailable: number;
  readonly safeModeCooldown: number | null;
  readonly ticksToDowngrade: number | null;
  readonly upgradeBlocked: number | null;
}

export interface SourceSnapshot {
  readonly energy: number;
  readonly energyCapacity: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly ticksToRegeneration: number | null;
}

export interface SpawnActivitySnapshot {
  readonly creepName: string;
  readonly needTime: number;
  readonly remainingTime: number;
}

export interface OwnedSpawnSnapshot {
  /** Current-tick controller/RCL activation, detached from the live structure. */
  readonly active: boolean;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly name: string;
  readonly pos: PositionSnapshot;
  readonly spawning: SpawnActivitySnapshot | null;
  readonly store: StoreSnapshot;
}

export interface OwnedExtensionSnapshot {
  /** Current-tick controller/RCL activation, detached from the live structure. */
  readonly active: boolean;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
}

export interface OwnedTowerSnapshot {
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
}

export interface OwnedLinkSnapshot {
  /** Current-tick controller/RCL activation, detached from the live structure. */
  readonly active: boolean;
  readonly cooldown: number;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
}

export interface OwnedLabSnapshot {
  /** Current-tick controller/RCL activation, detached from the live structure. */
  readonly active: boolean;
  readonly cooldown: number;
  readonly energy: number;
  readonly energyCapacity: number;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly mineralAmount: number;
  readonly mineralCapacity: number;
  readonly mineralType: string | null;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
}

export interface StoredStructureSnapshot {
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly ownerUsername: string | null;
  readonly ownership: "owned" | "foreign" | "unowned";
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
  readonly structureType: string;
  /** Runtime observations provide null for non-decaying stored structures. */
  readonly ticksToDecay?: number | null;
}

/** Visible road facts are kept separately because roads have no store and may be repaired locally. */
export interface RoadSnapshot {
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly ticksToDecay: number | null;
}

export interface ConstructionSiteSnapshot {
  readonly id: string;
  readonly ownerUsername: string;
  readonly ownership: "owned" | "foreign";
  readonly pos: PositionSnapshot;
  readonly progress: number;
  readonly progressTotal: number;
  readonly structureType: string;
}

export interface MineralSnapshot {
  /** Runtime observations always provide the current harvestable amount. */
  readonly amount?: number;
  /** Runtime observations always provide the current density constant. */
  readonly density?: number;
  readonly id: string;
  readonly mineralType: string;
  readonly pos: PositionSnapshot;
  /** Runtime observations always provide null while mineral is available. */
  readonly ticksToRegeneration?: number | null;
}

export interface OwnedExtractorSnapshot {
  readonly active: boolean;
  readonly cooldown: number;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
}

export interface OwnedStorageSnapshot {
  readonly active: boolean;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
}

export interface OwnedTerminalSnapshot extends OwnedStorageSnapshot {
  readonly cooldown: number;
}

export interface StructureSnapshot {
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly ownerUsername: string | null;
  readonly ownership: "owned" | "foreign" | "unowned";
  readonly pos: PositionSnapshot;
  readonly structureType: string;
  /** Present for ramparts; null for other runtime-observed structures. */
  readonly isPublic?: boolean | null;
  /** Present for decaying roads, containers, and ramparts; null otherwise. */
  readonly ticksToDecay?: number | null;
}

export interface TerrainSnapshot {
  /** Exactly 2,500 y-major cells encoded as 0 plain, 1 wall, or 2 swamp. */
  readonly cells: string;
  readonly revision: string;
}

export interface DroppedResourceSnapshot {
  readonly amount: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly resourceType: ResourceConstant;
}

export interface TombstoneSnapshot {
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
}

export interface RuinSnapshot {
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
}

export interface CreepSnapshot {
  readonly body: BodyCapabilitiesSnapshot;
  /** Absent when no bounded body part carries a boost. */
  readonly boosts?: readonly CreepBoostSnapshot[];
  readonly fatigue: number;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly name: string;
  readonly ownerUsername: string;
  readonly pos: PositionSnapshot;
  readonly spawning: boolean;
  readonly store: StoreSnapshot;
  readonly ticksToLive: number | null;
}

/** Reconstructible static traversal facts observed from a visible room. */
export interface StaticTraversalSnapshot {
  readonly revision: string;
  /** 2,500 y-major cells: `.` is walkable and `#` is a static blocker. */
  readonly walkability: string;
}

export interface RoomSnapshot {
  readonly constructionSites: readonly ConstructionSiteSnapshot[];
  readonly controller: ControllerSnapshot | null;
  readonly energyAvailable: number;
  readonly energyCapacityAvailable: number;
  readonly droppedResources?: readonly DroppedResourceSnapshot[];
  readonly hostileCreeps: readonly CreepSnapshot[];
  readonly exits?: readonly PositionSnapshot[];
  readonly mineral?: MineralSnapshot | null;
  readonly name: string;
  readonly observedAt: number;
  readonly ownedCreeps: readonly CreepSnapshot[];
  /** Absent only for legacy fixtures; runtime observations always provide a sorted array. */
  readonly ownedExtractors?: readonly OwnedExtractorSnapshot[];
  readonly ownedExtensions: readonly OwnedExtensionSnapshot[];
  /** Absent only for legacy fixtures; runtime observations always provide a sorted array. */
  readonly ownedLabs?: readonly OwnedLabSnapshot[];
  /** Absent only for legacy fixtures; runtime observations always provide a sorted array. */
  readonly ownedLinks?: readonly OwnedLinkSnapshot[];
  readonly ownedSpawns: readonly OwnedSpawnSnapshot[];
  /** Absent only for legacy fixtures; runtime observations always provide a sorted array. */
  readonly ownedStorages?: readonly OwnedStorageSnapshot[];
  /** Absent only for legacy fixtures; runtime observations always provide a sorted array. */
  readonly ownedTerminals?: readonly OwnedTerminalSnapshot[];
  readonly ownedTowers: readonly OwnedTowerSnapshot[];
  /** Absent only for legacy fixtures; runtime observations always provide a sorted array. */
  readonly roads?: readonly RoadSnapshot[];
  readonly ruins?: readonly RuinSnapshot[];
  readonly sources: readonly SourceSnapshot[];
  readonly storedStructures: readonly StoredStructureSnapshot[];
  /** Every visible structure, including walls and ramparts, detached from live objects. */
  readonly structures?: readonly StructureSnapshot[];
  readonly terrain?: TerrainSnapshot;
  readonly tombstones?: readonly TombstoneSnapshot[];
  /** Absent only when an adapter cannot supply static terrain; path planning then fails closed. */
  readonly traversal?: StaticTraversalSnapshot;
}

export interface OwnedRoomSnapshot extends RoomSnapshot {
  readonly controller: ControllerSnapshot & { readonly ownership: "owned" };
}

export interface RoomVisibilitySnapshot {
  /** Always zero for visible facts; null means the current state is unknown. */
  readonly age: 0 | null;
  readonly observedAt: number | null;
  readonly roomName: string;
  readonly status: RoomVisibilityStatus;
}

export interface VisibilitySnapshot {
  /** Rooms not listed as visible must be treated as unknown, never empty. */
  readonly absentRoomSemantics: "unknown";
  readonly rooms: readonly RoomVisibilitySnapshot[];
  readonly scope: "current-tick";
}

export interface SnapshotEntityCounts {
  readonly constructionSites: number;
  readonly controllers: number;
  readonly droppedResources?: number;
  readonly hostileCreeps: number;
  readonly ownedCreeps: number;
  readonly ownedExtensions: number;
  readonly ownedSpawns: number;
  readonly ownedTowers: number;
  readonly rooms: number;
  readonly ruins?: number;
  readonly sources: number;
  readonly storedStructures: number;
  readonly tombstones?: number;
  readonly total: number;
}

export interface WorldSnapshotStats {
  readonly entities: SnapshotEntityCounts;
  /** UTF-8 byte estimate of the snapshot payload before this stats object is appended. */
  readonly estimatedPayloadBytes: number;
}

export interface SnapshotObservation {
  /** Current observations are always age zero; empty bootstrap snapshots have unknown age. */
  readonly age: 0 | null;
  readonly shard: string;
  readonly status: SnapshotObservationStatus;
  readonly tick: number;
}

export interface WorldSnapshot {
  readonly observation: SnapshotObservation;
  /** Backwards-compatible alias for observation.tick. */
  readonly observedAt: number;
  /** Authoritative shard-global count from Game.constructionSites when observation is available. */
  readonly ownedConstructionSiteCount: number;
  readonly ownedRooms: readonly OwnedRoomSnapshot[];
  readonly rooms: readonly RoomSnapshot[];
  readonly schemaVersion: typeof WORLD_SNAPSHOT_SCHEMA_VERSION;
  readonly stats: WorldSnapshotStats;
  readonly visibility: VisibilitySnapshot;
}

export function emptyWorldSnapshot(observedAt: number, shard = "unknown"): WorldSnapshot {
  const entities = emptyEntityCounts();
  const payload = {
    observation: {
      age: null,
      shard,
      status: "empty" as const,
      tick: observedAt,
    },
    observedAt,
    ownedConstructionSiteCount: 0,
    ownedRooms: [],
    rooms: [],
    schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    visibility: {
      absentRoomSemantics: "unknown" as const,
      rooms: [],
      scope: "current-tick" as const,
    },
  };

  return deepFreeze({
    ...payload,
    stats: {
      entities,
      estimatedPayloadBytes: utf8ByteLength(JSON.stringify(payload)),
    },
  });
}

export function freezeWorldSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  return deepFreeze(snapshot);
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

function emptyEntityCounts(): SnapshotEntityCounts {
  return {
    constructionSites: 0,
    controllers: 0,
    droppedResources: 0,
    hostileCreeps: 0,
    ownedCreeps: 0,
    ownedExtensions: 0,
    ownedSpawns: 0,
    ownedTowers: 0,
    rooms: 0,
    ruins: 0,
    sources: 0,
    storedStructures: 0,
    tombstones: 0,
    total: 0,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.isFrozen(value) ? value : Object.freeze(value);
}
