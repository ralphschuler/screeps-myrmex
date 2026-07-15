export const WORLD_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SnapshotObservationStatus = "observed" | "empty";
export type RoomVisibilityStatus = "visible" | "unknown";
export type ControllerOwnership = "owned" | "foreign" | "reserved" | "neutral";

export interface PositionSnapshot {
  readonly roomName: string;
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

export interface StoredStructureSnapshot {
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly ownerUsername: string | null;
  readonly ownership: "owned" | "foreign" | "unowned";
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot;
  readonly structureType: string;
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

export interface CreepSnapshot {
  readonly body: BodyCapabilitiesSnapshot;
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
  readonly hostileCreeps: readonly CreepSnapshot[];
  readonly name: string;
  readonly observedAt: number;
  readonly ownedCreeps: readonly CreepSnapshot[];
  readonly ownedExtensions: readonly OwnedExtensionSnapshot[];
  readonly ownedSpawns: readonly OwnedSpawnSnapshot[];
  readonly ownedTowers: readonly OwnedTowerSnapshot[];
  readonly sources: readonly SourceSnapshot[];
  readonly storedStructures: readonly StoredStructureSnapshot[];
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
  readonly hostileCreeps: number;
  readonly ownedCreeps: number;
  readonly ownedExtensions: number;
  readonly ownedSpawns: number;
  readonly ownedTowers: number;
  readonly rooms: number;
  readonly sources: number;
  readonly storedStructures: number;
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
    hostileCreeps: 0,
    ownedCreeps: 0,
    ownedExtensions: 0,
    ownedSpawns: 0,
    ownedTowers: 0,
    rooms: 0,
    sources: 0,
    storedStructures: 0,
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
