import type { SegmentCodec } from "../../segments";
import type {
  BodyCapabilitiesSnapshot,
  ControllerOwnership,
  CreepSnapshot,
  PositionSnapshot,
  RoomEventLogStatus,
  RoomEventSnapshot,
  RoomSnapshot,
  StructureSnapshot,
} from "../snapshot";

export const ROOM_INTEL_SCHEMA_VERSION = 1 as const;

export const INTEL_LIMITS = Object.freeze({
  maximumEncodedRoomCodeUnits: 90_000,
  maximumEventsPerRoom: 64,
  maximumHostilesPerRoom: 32,
  maximumSourcesPerRoom: 8,
  maximumStructuresPerRoom: 128,
  maximumStringCodeUnits: 128,
} as const);

export type IntelCollectionStatus = "complete" | "limit-exceeded" | "unavailable";

export interface RoomIntelPosition {
  readonly x: number;
  readonly y: number;
}

export interface RoomIntelSource {
  readonly energyCapacity: number;
  readonly id: string;
  readonly pos: RoomIntelPosition;
}

export interface RoomIntelController {
  readonly id: string;
  readonly level: number;
  readonly ownerUsername: string | null;
  readonly ownership: ControllerOwnership;
  readonly pos: RoomIntelPosition;
  readonly reservationTicksToEnd: number | null;
  readonly reservationUsername: string | null;
  readonly safeMode: number | null;
}

export interface RoomIntelMineral {
  readonly id: string;
  readonly mineralType: string;
  readonly pos: RoomIntelPosition;
}

export interface RoomIntelStructure {
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly invaderCore: { readonly level: number; readonly ticksToDeploy: number | null } | null;
  readonly isPublic: boolean | null;
  readonly ownerUsername: string | null;
  readonly ownership: StructureSnapshot["ownership"];
  readonly portal: {
    readonly destinationRoomName: string;
    readonly destinationShard: string | null;
    readonly x: number | null;
    readonly y: number | null;
  } | null;
  readonly pos: RoomIntelPosition;
  readonly structureType: string;
  readonly ticksToDecay: number | null;
}

export interface RoomIntelHostile {
  readonly body: BodyCapabilitiesSnapshot;
  readonly hits: number;
  readonly hitsMax: number;
  readonly id: string;
  readonly ownerUsername: string;
  readonly pos: RoomIntelPosition;
  readonly ticksToLive: number | null;
}

export interface RoomIntelRecordV1 {
  readonly schemaVersion: typeof ROOM_INTEL_SCHEMA_VERSION;
  readonly shard: string;
  readonly roomName: string;
  readonly observedAt: number;
  /** Event rows came from the previous tick relative to observedAt. */
  readonly eventsObservedAt: number | null;
  readonly complete: boolean;
  readonly terrain: { readonly cells: string; readonly revision: string } | null;
  readonly controller: RoomIntelController | null;
  readonly mineral: RoomIntelMineral | null;
  readonly mineralStatus: Extract<IntelCollectionStatus, "complete" | "unavailable">;
  readonly sources: readonly RoomIntelSource[];
  readonly sourceStatus: IntelCollectionStatus;
  readonly structures: readonly RoomIntelStructure[];
  readonly structureStatus: IntelCollectionStatus;
  readonly hostiles: readonly RoomIntelHostile[];
  readonly hostileStatus: IntelCollectionStatus;
  readonly events: readonly RoomEventSnapshot[];
  readonly eventLogStatus: RoomEventLogStatus;
}

export function projectRoomIntelRecord(
  room: RoomSnapshot,
  shard: string,
): RoomIntelRecordV1 | null {
  if (!validRoomName(room.name) || !boundedIdentity(shard) || !nonnegative(room.observedAt)) {
    return null;
  }
  const sources = boundedProjection(
    room.sources,
    INTEL_LIMITS.maximumSourcesPerRoom,
    (source): RoomIntelSource => ({
      energyCapacity: source.energyCapacity,
      id: source.id,
      pos: position(source.pos),
    }),
    compareId,
  );
  const structures =
    room.structures === undefined
      ? {
          values: Object.freeze([]) as readonly RoomIntelStructure[],
          status: "unavailable" as const,
        }
      : boundedProjection(
          room.structures,
          INTEL_LIMITS.maximumStructuresPerRoom,
          structure,
          compareId,
        );
  const hostiles = boundedProjection(
    room.hostileCreeps,
    INTEL_LIMITS.maximumHostilesPerRoom,
    hostile,
    compareId,
  );
  const events: {
    readonly values: readonly RoomEventSnapshot[];
    readonly status: RoomEventLogStatus;
  } =
    room.events === undefined || room.eventLogStatus === undefined
      ? {
          values: Object.freeze([]),
          status: "unavailable",
        }
      : room.eventLogStatus !== "observed" || room.events.length > INTEL_LIMITS.maximumEventsPerRoom
        ? {
            values: Object.freeze([]),
            status: room.eventLogStatus === "unavailable" ? "unavailable" : "limit-exceeded",
          }
        : {
            values: Object.freeze(
              [...room.events].map((event) => ({ ...event })).sort(compareEvent),
            ),
            status: "observed",
          };
  const mineralStatus = room.mineral === undefined ? "unavailable" : "complete";
  const complete =
    room.terrain !== undefined &&
    mineralStatus === "complete" &&
    sources.status === "complete" &&
    structures.status === "complete" &&
    hostiles.status === "complete" &&
    events.status === "observed";
  const value: RoomIntelRecordV1 = {
    schemaVersion: ROOM_INTEL_SCHEMA_VERSION,
    shard,
    roomName: room.name,
    observedAt: room.observedAt,
    eventsObservedAt: events.status === "observed" ? Math.max(0, room.observedAt - 1) : null,
    complete,
    terrain:
      room.terrain === undefined
        ? null
        : { cells: room.terrain.cells, revision: room.terrain.revision },
    controller:
      room.controller === null
        ? null
        : {
            id: room.controller.id,
            level: room.controller.level,
            ownerUsername: room.controller.ownerUsername,
            ownership: room.controller.ownership,
            pos: position(room.controller.pos),
            reservationTicksToEnd: room.controller.reservationTicksToEnd,
            reservationUsername: room.controller.reservationUsername,
            safeMode: room.controller.safeMode,
          },
    mineral:
      room.mineral === undefined || room.mineral === null
        ? null
        : {
            id: room.mineral.id,
            mineralType: room.mineral.mineralType,
            pos: position(room.mineral.pos),
          },
    mineralStatus,
    sources: sources.values,
    sourceStatus: sources.status,
    structures: structures.values,
    structureStatus: structures.status,
    hostiles: hostiles.values,
    hostileStatus: hostiles.status,
    events: events.values,
    eventLogStatus: events.status,
  };
  const frozen = deepFreeze(value);
  return validRoomIntelRecord(frozen) &&
    JSON.stringify(frozen).length <= INTEL_LIMITS.maximumEncodedRoomCodeUnits
    ? frozen
    : null;
}

export function createRoomIntelCodec(): SegmentCodec<RoomIntelRecordV1> {
  return Object.freeze({
    encode(value: RoomIntelRecordV1): string {
      if (!validRoomIntelRecord(value)) throw new TypeError("Invalid room intelligence record");
      const encoded = JSON.stringify(value);
      if (encoded.length > INTEL_LIMITS.maximumEncodedRoomCodeUnits) {
        throw new RangeError("Room intelligence record exceeds its segment bound");
      }
      return encoded;
    },
    decode(encoded: string): RoomIntelRecordV1 {
      if (
        typeof encoded !== "string" ||
        encoded.length === 0 ||
        encoded.length > INTEL_LIMITS.maximumEncodedRoomCodeUnits
      ) {
        throw new TypeError("Invalid encoded room intelligence record");
      }
      const value = JSON.parse(encoded) as unknown;
      if (!validRoomIntelRecord(value)) throw new TypeError("Invalid room intelligence record");
      return deepFreeze(value);
    },
  });
}

export function validRoomIntelRecord(value: unknown): value is RoomIntelRecordV1 {
  if (
    !record(value) ||
    !exactKeys(value, [
      "complete",
      "controller",
      "eventLogStatus",
      "events",
      "eventsObservedAt",
      "hostileStatus",
      "hostiles",
      "mineral",
      "mineralStatus",
      "observedAt",
      "roomName",
      "schemaVersion",
      "shard",
      "sourceStatus",
      "sources",
      "structureStatus",
      "structures",
      "terrain",
    ]) ||
    value.schemaVersion !== ROOM_INTEL_SCHEMA_VERSION ||
    !boundedIdentity(value.shard) ||
    !validRoomName(value.roomName) ||
    !nonnegative(value.observedAt) ||
    typeof value.complete !== "boolean" ||
    !nullableNonnegative(value.eventsObservedAt) ||
    !collectionStatus(value.sourceStatus) ||
    !collectionStatus(value.structureStatus) ||
    !collectionStatus(value.hostileStatus) ||
    !eventStatus(value.eventLogStatus) ||
    !Array.isArray(value.sources) ||
    value.sources.length > INTEL_LIMITS.maximumSourcesPerRoom ||
    !Array.isArray(value.structures) ||
    value.structures.length > INTEL_LIMITS.maximumStructuresPerRoom ||
    !Array.isArray(value.hostiles) ||
    value.hostiles.length > INTEL_LIMITS.maximumHostilesPerRoom ||
    !Array.isArray(value.events) ||
    value.events.length > INTEL_LIMITS.maximumEventsPerRoom ||
    !validTerrain(value.terrain) ||
    !validController(value.controller) ||
    !validMineral(value.mineral) ||
    (value.mineralStatus !== "complete" && value.mineralStatus !== "unavailable") ||
    !value.sources.every(validSource) ||
    !value.structures.every(validStructure) ||
    !value.hostiles.every(validHostile) ||
    !value.events.every(validEvent) ||
    !canonical(value.sources, compareId) ||
    !canonical(value.structures, compareId) ||
    !canonical(value.hostiles, compareId) ||
    !canonical(value.events, compareEvent)
  ) {
    return false;
  }
  if (
    (value.mineralStatus === "unavailable" && value.mineral !== null) ||
    (value.sourceStatus !== "complete" && value.sources.length !== 0) ||
    (value.structureStatus !== "complete" && value.structures.length !== 0) ||
    (value.hostileStatus !== "complete" && value.hostiles.length !== 0) ||
    (value.eventLogStatus !== "observed" && value.events.length !== 0) ||
    (value.eventLogStatus === "observed") !== (value.eventsObservedAt !== null) ||
    (value.eventsObservedAt !== null &&
      value.eventsObservedAt !== Math.max(0, value.observedAt - 1))
  ) {
    return false;
  }
  const expectedComplete =
    value.terrain !== null &&
    value.mineralStatus === "complete" &&
    value.sourceStatus === "complete" &&
    value.structureStatus === "complete" &&
    value.hostileStatus === "complete" &&
    value.eventLogStatus === "observed";
  return value.complete === expectedComplete;
}

function structure(value: StructureSnapshot): RoomIntelStructure {
  return {
    hits: value.hits,
    hitsMax: value.hitsMax,
    id: value.id,
    invaderCore: value.invaderCore === undefined ? null : { ...value.invaderCore },
    isPublic: value.isPublic ?? null,
    ownerUsername: value.ownerUsername,
    ownership: value.ownership,
    portal: value.portal === undefined ? null : { ...value.portal },
    pos: position(value.pos),
    structureType: value.structureType,
    ticksToDecay: value.ticksToDecay ?? null,
  };
}

function hostile(value: CreepSnapshot): RoomIntelHostile {
  return {
    body: value.body,
    hits: value.hits,
    hitsMax: value.hitsMax,
    id: value.id,
    ownerUsername: value.ownerUsername,
    pos: position(value.pos),
    ticksToLive: value.ticksToLive,
  };
}

function position(value: PositionSnapshot): RoomIntelPosition {
  return { x: value.x, y: value.y };
}

function boundedProjection<Input, Output extends { readonly id: string }>(
  input: readonly Input[],
  maximum: number,
  project: (value: Input) => Output,
  compare: (left: Output, right: Output) => number,
): { readonly values: readonly Output[]; readonly status: IntelCollectionStatus } {
  if (input.length > maximum) return { values: Object.freeze([]), status: "limit-exceeded" };
  return {
    values: Object.freeze(input.map(project).sort(compare)),
    status: "complete",
  };
}

function validTerrain(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      exactKeys(value, ["cells", "revision"]) &&
      typeof value.cells === "string" &&
      /^[012]{2500}$/u.test(value.cells) &&
      boundedIdentity(value.revision))
  );
}

function validController(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      exactKeys(value, [
        "id",
        "level",
        "ownerUsername",
        "ownership",
        "pos",
        "reservationTicksToEnd",
        "reservationUsername",
        "safeMode",
      ]) &&
      boundedIdentity(value.id) &&
      nonnegative(value.level) &&
      value.level <= 8 &&
      nullableIdentity(value.ownerUsername) &&
      ["owned", "foreign", "reserved", "neutral"].includes(String(value.ownership)) &&
      validPosition(value.pos) &&
      nullableNonnegative(value.reservationTicksToEnd) &&
      nullableIdentity(value.reservationUsername) &&
      nullableNonnegative(value.safeMode))
  );
}

function validMineral(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      exactKeys(value, ["id", "mineralType", "pos"]) &&
      boundedIdentity(value.id) &&
      boundedIdentity(value.mineralType) &&
      validPosition(value.pos))
  );
}

function validSource(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["energyCapacity", "id", "pos"]) &&
    nonnegative(value.energyCapacity) &&
    boundedIdentity(value.id) &&
    validPosition(value.pos)
  );
}

function validStructure(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "hits",
      "hitsMax",
      "id",
      "invaderCore",
      "isPublic",
      "ownerUsername",
      "ownership",
      "portal",
      "pos",
      "structureType",
      "ticksToDecay",
    ]) &&
    nonnegative(value.hits) &&
    nonnegative(value.hitsMax) &&
    value.hits <= value.hitsMax &&
    boundedIdentity(value.id) &&
    (value.invaderCore === null ||
      (record(value.invaderCore) &&
        exactKeys(value.invaderCore, ["level", "ticksToDeploy"]) &&
        nonnegative(value.invaderCore.level) &&
        nullableNonnegative(value.invaderCore.ticksToDeploy))) &&
    (value.isPublic === null || typeof value.isPublic === "boolean") &&
    nullableIdentity(value.ownerUsername) &&
    ["owned", "foreign", "unowned"].includes(String(value.ownership)) &&
    (value.portal === null ||
      (record(value.portal) &&
        exactKeys(value.portal, ["destinationRoomName", "destinationShard", "x", "y"]) &&
        validRoomName(value.portal.destinationRoomName) &&
        nullableIdentity(value.portal.destinationShard) &&
        nullableCoordinate(value.portal.x) &&
        nullableCoordinate(value.portal.y))) &&
    validPosition(value.pos) &&
    boundedIdentity(value.structureType) &&
    nullableNonnegative(value.ticksToDecay)
  );
}

function validHostile(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["body", "hits", "hitsMax", "id", "ownerUsername", "pos", "ticksToLive"]) &&
    validBody(value.body) &&
    nonnegative(value.hits) &&
    nonnegative(value.hitsMax) &&
    value.hits <= value.hitsMax &&
    boundedIdentity(value.id) &&
    boundedIdentity(value.ownerUsername) &&
    validPosition(value.pos) &&
    nullableNonnegative(value.ticksToLive)
  );
}

function validBody(value: unknown): boolean {
  if (!record(value)) return false;
  const parts = ["attack", "carry", "claim", "heal", "move", "rangedAttack", "tough", "work"];
  if (
    !exactKeys(value, ["activeParts", ...parts, "size"]) ||
    !nonnegative(value.activeParts) ||
    !nonnegative(value.size) ||
    value.size > 50
  ) {
    return false;
  }
  let activeParts = 0;
  let totalParts = 0;
  for (const part of parts) {
    const count = value[part];
    if (
      !record(count) ||
      !exactKeys(count, ["active", "boosted", "total"]) ||
      !nonnegative(count.active) ||
      !nonnegative(count.boosted) ||
      !nonnegative(count.total) ||
      count.active > count.total ||
      count.active > value.activeParts ||
      count.boosted > count.total ||
      count.total > value.size
    ) {
      return false;
    }
    activeParts += count.active;
    totalParts += count.total;
  }
  return activeParts === value.activeParts && totalParts === value.size;
}

function validEvent(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "amount",
      "attackType",
      "event",
      "objectId",
      "resourceType",
      "structureType",
      "targetId",
      "x",
      "y",
    ]) &&
    nonnegative(value.event) &&
    boundedIdentity(value.objectId) &&
    nullableIdentity(value.targetId) &&
    nullableNonnegative(value.amount) &&
    nullableNonnegative(value.attackType) &&
    nullableIdentity(value.resourceType) &&
    nullableIdentity(value.structureType) &&
    nullableCoordinate(value.x) &&
    nullableCoordinate(value.y)
  );
}

function validPosition(value: unknown): boolean {
  return (
    record(value) && exactKeys(value, ["x", "y"]) && coordinate(value.x) && coordinate(value.y)
  );
}

function compareId(left: { readonly id: string }, right: { readonly id: string }): number {
  return compare(left.id, right.id);
}

function compareEvent(left: RoomEventSnapshot, right: RoomEventSnapshot): number {
  return (
    left.event - right.event ||
    compare(left.objectId, right.objectId) ||
    compare(left.targetId ?? "", right.targetId ?? "") ||
    (left.attackType ?? -1) - (right.attackType ?? -1) ||
    (left.amount ?? -1) - (right.amount ?? -1) ||
    compare(left.resourceType ?? "", right.resourceType ?? "") ||
    compare(left.structureType ?? "", right.structureType ?? "") ||
    (left.y ?? -1) - (right.y ?? -1) ||
    (left.x ?? -1) - (right.x ?? -1)
  );
}

function canonical<Value>(
  values: readonly Value[],
  compareValues: (a: Value, b: Value) => number,
): boolean {
  return values.every(
    (value, index) => index === 0 || compareValues(values[index - 1] as Value, value) <= 0,
  );
}

function collectionStatus(value: unknown): value is IntelCollectionStatus {
  return value === "complete" || value === "limit-exceeded" || value === "unavailable";
}
function eventStatus(value: unknown): value is RoomEventLogStatus {
  return value === "observed" || value === "unavailable" || value === "limit-exceeded";
}
function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compare);
  const sorted = [...expected].sort(compare);
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= INTEL_LIMITS.maximumStringCodeUnits &&
    value === value.trim()
  );
}
function nullableIdentity(value: unknown): boolean {
  return value === null || boundedIdentity(value);
}
function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^(W|E)\d+(N|S)\d+$/u.test(value) && value.length <= 16;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nullableNonnegative(value: unknown): boolean {
  return value === null || nonnegative(value);
}
function coordinate(value: unknown): boolean {
  return nonnegative(value) && value <= 49;
}
function nullableCoordinate(value: unknown): boolean {
  return value === null || coordinate(value);
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
