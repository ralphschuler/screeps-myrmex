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
const MAX_GOAL_OSCILLATION_AGE = 100;
const MAX_GOAL_SEQUENCE_GAP_TICKS = 3;

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
  readonly kind: "attempt";
  readonly observedAt: number;
  readonly range: number;
  readonly stuckAge: number;
}

interface ActorGoalSequenceRecord {
  readonly [field: string]: JsonValue;
  readonly currentSignature: string;
  readonly kind: "goal-sequence";
  readonly observedAt: number;
  readonly oscillationAge: number;
  readonly previousSignature: string | null;
}

type MovementProgressRecord = MovementAttemptRecord | ActorGoalSequenceRecord;
type MovementProgressKey =
  readonly ["attempt", string, string] | readonly ["goal-sequence", string];

export interface MovementProgressQuery {
  readonly actorId: string;
  readonly actorPosition: PositionSnapshot;
  readonly contractId: string;
  readonly contractRevision: number;
  /** Stable only while the semantic action, target, goal, and range are equivalent. */
  readonly episodeKey?: string;
  readonly goal: PositionSnapshot;
  readonly range: number;
  readonly tick: number;
}

export interface MovementProgressView {
  goalOscillationAge?(query: MovementProgressQuery): number;
  stuckAge(query: MovementProgressQuery): number;
}

export const EMPTY_MOVEMENT_PROGRESS_VIEW: MovementProgressView = Object.freeze({
  goalOscillationAge: () => 0,
  stuckAge: () => 0,
});

/**
 * Reconstructible heap-only evidence for one exact prior movement attempt. Losing this cache may
 * delay congestion recovery, but it cannot authorize a command or change lease ownership.
 */
export class MovementProgressTracker implements MovementProgressView {
  public constructor(
    private readonly records: CacheNamespace<MovementProgressKey, MovementProgressRecord>,
  ) {}

  public stuckAge(query: MovementProgressQuery): number {
    if (!isValidQuery(query)) return 0;
    let previous: ReturnType<typeof this.records.get>;
    try {
      previous = this.records.get(["attempt", query.actorId, movementEpisodeKey(query)], {
        tick: query.tick,
      });
    } catch {
      return 0;
    }
    if (!previous.hit) return 0;
    const record = previous.value;
    if (record.kind !== "attempt") return 0;
    if (
      record.observedAt !== query.tick - 1 ||
      (query.episodeKey === undefined && record.contractRevision !== query.contractRevision) ||
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

  public goalOscillationAge(query: MovementProgressQuery): number {
    if (!isValidQuery(query)) return 0;
    let previous: ReturnType<typeof this.records.get>;
    try {
      previous = this.records.get(["goal-sequence", query.actorId], {
        tick: query.tick,
      });
    } catch {
      return 0;
    }
    if (!previous.hit) return 0;
    const record = previous.value;
    if (record.kind !== "goal-sequence") return 0;
    if (
      record.observedAt >= query.tick ||
      query.tick - record.observedAt > MAX_GOAL_SEQUENCE_GAP_TICKS
    )
      return 0;
    const signature = movementGoalSignature(query);
    return signature === record.previousSignature && signature !== record.currentSignature
      ? Math.min(MAX_GOAL_OSCILLATION_AGE, record.oscillationAge + 1)
      : 0;
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
          movementEvidenceRank(left.reason) - movementEvidenceRank(right.reason) ||
          compareStrings(left.intent.contractId ?? "", right.intent.contractId ?? "") ||
          compareStrings(left.intent.id, right.intent.id),
      );
    const recordedActorGoals = new Set<string>();
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
        const episodeKey = movementIntentEpisodeKey(intent);
        this.records.set(
          ["attempt", intent.actorId, episodeKey],
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
            kind: "attempt",
            observedAt: tick,
            range: intent.range,
            stuckAge: Math.min(MAX_STUCK_AGE, intent.stuckAge),
          },
          { tick },
        );
        if (!recordedActorGoals.has(intent.actorId)) {
          this.recordActorGoal(intent, tick);
          recordedActorGoals.add(intent.actorId);
        }
      } catch {
        // Heap-only quality evidence must never fault command publication or durable reconciliation.
      }
    }
  }

  private recordActorGoal(
    intent: MovementRuntimeResult["movementExecution"][number]["intent"],
    tick: number,
  ): void {
    const signature = movementIntentGoalSignature(intent);
    let previous: ReturnType<typeof this.records.get>;
    try {
      previous = this.records.get(["goal-sequence", intent.actorId], { tick });
    } catch {
      return;
    }
    const recent =
      previous.hit &&
      previous.value.kind === "goal-sequence" &&
      previous.value.observedAt < tick &&
      tick - previous.value.observedAt <= MAX_GOAL_SEQUENCE_GAP_TICKS
        ? previous.value
        : null;
    const oscillationAge =
      recent !== null &&
      signature === recent.previousSignature &&
      signature !== recent.currentSignature
        ? Math.min(MAX_GOAL_OSCILLATION_AGE, recent.oscillationAge + 1)
        : 0;
    this.records.set(
      ["goal-sequence", intent.actorId],
      {
        currentSignature: signature,
        kind: "goal-sequence",
        observedAt: tick,
        oscillationAge,
        previousSignature: recent?.currentSignature ?? null,
      },
      { tick },
    );
  }
}

const trackers = new WeakMap<CacheManager, MovementProgressTracker>();

export function getMovementProgressTracker(manager: CacheManager): MovementProgressTracker {
  const existing = trackers.get(manager);
  if (existing !== undefined) return existing;
  const records = manager.register<MovementProgressKey, MovementProgressRecord>({
    id: "movement.progress.v1",
    owner: "movement.arbiter",
    version: 1,
    capacity: MAX_MOVEMENT_PROGRESS_RECORDS,
    maxKeyLength: 512,
    maxEncodedLength: 1_024,
    estimatedRebuildCpu: 0,
    ttlTicks: MAX_GOAL_SEQUENCE_GAP_TICKS + 1,
    keyOf: (key) => key,
    codec: createJsonCacheCodec<MovementProgressRecord>(),
  });
  const tracker = new MovementProgressTracker(records);
  trackers.set(manager, tracker);
  return tracker;
}

function isValidQuery(query: MovementProgressQuery): boolean {
  return (
    query.actorId.length > 0 &&
    query.actorId.length <= 128 &&
    query.contractId.length > 0 &&
    Number.isSafeInteger(query.contractRevision) &&
    query.contractRevision >= 0 &&
    isPosition(query.actorPosition) &&
    isPosition(query.goal) &&
    Number.isSafeInteger(query.range) &&
    query.range >= 0 &&
    Number.isSafeInteger(query.tick) &&
    query.tick > 0 &&
    (query.episodeKey === undefined ||
      (query.episodeKey.length > 0 && query.episodeKey.length <= 512))
  );
}

function movementEpisodeKey(query: MovementProgressQuery): string {
  return query.episodeKey ?? query.contractId;
}

function movementIntentEpisodeKey(
  intent: MovementRuntimeResult["movementExecution"][number]["intent"],
): string {
  return intent.episodeKey ?? intent.contractId ?? intent.id;
}

function movementGoalSignature(query: MovementProgressQuery): string {
  return goalSignature(movementEpisodeKey(query), query.goal, query.range);
}

function movementIntentGoalSignature(
  intent: MovementRuntimeResult["movementExecution"][number]["intent"],
): string {
  return goalSignature(movementIntentEpisodeKey(intent), intent.goal, intent.range);
}

function goalSignature(episodeKey: string, goal: PositionSnapshot, range: number): string {
  return `${episodeKey}|${goal.roomName}:${String(goal.x)}:${String(goal.y)}:${String(range)}`;
}

function movementEvidenceRank(
  reason: MovementRuntimeResult["movementExecution"][number]["reason"],
): number {
  return reason === "accepted" ? 0 : reason === "blocked" ? 1 : 2;
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
