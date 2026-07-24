import {
  createJsonCacheCodec,
  type CacheManager,
  type CacheNamespace,
  type JsonValue,
} from "../cache";
import type { PositionSnapshot, WorldSnapshot } from "../world/snapshot";
import type { MovementRuntimeResult } from "./contracts";

const MAX_MOVEMENT_PROGRESS_RECORDS = 128;
const MAX_STUCK_AGE = 100;

interface MovementAttemptRecord {
  readonly [field: string]: JsonValue;
  readonly actorRoomName: string;
  readonly actorX: number;
  readonly actorY: number;
  readonly contractRevision: number;
  readonly destinationRoomName: string;
  readonly destinationX: number;
  readonly destinationY: number;
  readonly direction: number | null;
  readonly goalRoomName: string;
  readonly goalX: number;
  readonly goalY: number;
  readonly observedAt: number;
  readonly range: number;
  readonly stuckAge: number;
}

export interface MovementProgressQuery {
  readonly actorId: string;
  readonly actorPosition: PositionSnapshot;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly goal: PositionSnapshot;
  readonly range: number;
  readonly tick: number;
}

export interface MovementProgressView {
  stuckAge(query: MovementProgressQuery): number;
}

export const EMPTY_MOVEMENT_PROGRESS_VIEW: MovementProgressView = Object.freeze({
  stuckAge: () => 0,
});

/**
 * Reconstructible heap-only evidence for one exact prior movement attempt. Losing this cache may
 * delay congestion recovery, but it cannot authorize a command or change lease ownership.
 */
export class MovementProgressTracker implements MovementProgressView {
  public constructor(
    private readonly records: CacheNamespace<readonly [string, string], MovementAttemptRecord>,
  ) {}

  public stuckAge(query: MovementProgressQuery): number {
    if (!isValidQuery(query)) return 0;
    let previous: ReturnType<typeof this.records.get>;
    try {
      previous = this.records.get([query.actorId, query.contractId], { tick: query.tick });
    } catch {
      return 0;
    }
    if (!previous.hit) return 0;
    const record = previous.value;
    if (
      record.observedAt !== query.tick - 1 ||
      record.contractRevision !== query.contractRevision ||
      record.goalRoomName !== query.goal.roomName ||
      record.goalX !== query.goal.x ||
      record.goalY !== query.goal.y ||
      record.range !== query.range ||
      record.actorRoomName !== query.actorPosition.roomName ||
      record.actorX !== query.actorPosition.x ||
      record.actorY !== query.actorPosition.y
    )
      return 0;
    return Math.min(MAX_STUCK_AGE, record.stuckAge + 1);
  }

  public record(result: MovementRuntimeResult, snapshot: WorldSnapshot, tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < 0) return;
    const actors = new Map(
      snapshot.rooms.flatMap((room) => room.ownedCreeps).map((actor) => [actor.id, actor.pos]),
    );
    const attempts = result.movementExecution
      .filter(
        ({ intent, reason }) =>
          intent.contractId !== null &&
          intent.contractRevision !== null &&
          (reason === "accepted" || reason === "blocked" || reason === "no-path"),
      )
      .slice()
      .sort(
        (left, right) =>
          compareStrings(left.intent.actorId, right.intent.actorId) ||
          compareStrings(left.intent.contractId ?? "", right.intent.contractId ?? "") ||
          compareStrings(left.intent.id, right.intent.id),
      );
    for (const { intent } of attempts) {
      const actorPosition = actors.get(intent.actorId);
      const contractId = intent.contractId;
      const contractRevision = intent.contractRevision;
      if (
        actorPosition === undefined ||
        contractId === null ||
        contractRevision === null ||
        !Number.isSafeInteger(intent.stuckAge) ||
        intent.stuckAge < 0
      )
        continue;
      try {
        this.records.set(
          [intent.actorId, contractId],
          {
            actorRoomName: actorPosition.roomName,
            actorX: actorPosition.x,
            actorY: actorPosition.y,
            contractRevision,
            destinationRoomName: intent.destination.roomName,
            destinationX: intent.destination.x,
            destinationY: intent.destination.y,
            direction: intent.direction,
            goalRoomName: intent.goal.roomName,
            goalX: intent.goal.x,
            goalY: intent.goal.y,
            observedAt: tick,
            range: intent.range,
            stuckAge: Math.min(MAX_STUCK_AGE, intent.stuckAge),
          },
          { tick },
        );
      } catch {
        // Heap-only quality evidence must never fault command publication or durable reconciliation.
      }
    }
  }
}

const trackers = new WeakMap<CacheManager, MovementProgressTracker>();

export function getMovementProgressTracker(manager: CacheManager): MovementProgressTracker {
  const existing = trackers.get(manager);
  if (existing !== undefined) return existing;
  const records = manager.register<readonly [string, string], MovementAttemptRecord>({
    id: "movement.progress.v1",
    owner: "movement.arbiter",
    version: 1,
    capacity: MAX_MOVEMENT_PROGRESS_RECORDS,
    maxKeyLength: 512,
    maxEncodedLength: 1_024,
    estimatedRebuildCpu: 0,
    ttlTicks: 2,
    keyOf: (key) => key,
    codec: createJsonCacheCodec<MovementAttemptRecord>(),
  });
  const tracker = new MovementProgressTracker(records);
  trackers.set(manager, tracker);
  return tracker;
}

function isValidQuery(query: MovementProgressQuery): boolean {
  return (
    query.actorId.length > 0 &&
    query.contractId.length > 0 &&
    Number.isSafeInteger(query.contractRevision) &&
    query.contractRevision >= 0 &&
    isPosition(query.actorPosition) &&
    isPosition(query.goal) &&
    Number.isSafeInteger(query.range) &&
    query.range >= 0 &&
    Number.isSafeInteger(query.tick) &&
    query.tick > 0
  );
}

function isPosition(position: PositionSnapshot): boolean {
  return (
    position.roomName.length > 0 &&
    Number.isSafeInteger(position.x) &&
    position.x >= 0 &&
    position.x <= 49 &&
    Number.isSafeInteger(position.y) &&
    position.y >= 0 &&
    position.y <= 49
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
