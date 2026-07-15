import type {
  CreepActionDecision,
  CreepActionIntent,
  MovementActor,
  MovementDecision,
  MovementIntent,
} from "./contracts";

/** The sole local authority that resolves one movement destination per actor and tile. */
export class MovementArbiter {
  public arbitrate(
    tick: number,
    actors: readonly MovementActor[],
    intents: readonly MovementIntent[],
  ): readonly MovementDecision[] {
    const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
    const accepted = new Map<string, MovementIntent>();
    const reserved = new Map<string, string>();
    const decisions: MovementDecision[] = [];

    for (const intent of intents.slice().sort(compareMovementIntent)) {
      const actor = actorsById.get(intent.actorId);
      if (actor === undefined) {
        decisions.push(decision(intent, "stale-actor"));
      } else if (!isValidIntent(intent, actor, tick)) {
        decisions.push(decision(intent, intent.direction === null ? "no-path" : "invalid-goal"));
      } else if (actor.fatigue > 0) {
        decisions.push(decision(intent, "fatigued"));
      } else {
        const key = positionKey(intent.destination);
        const winner = reserved.get(key);
        if (winner === undefined || permitsSwap(intent, accepted.get(winner), actorsById)) {
          accepted.set(intent.actorId, intent);
          reserved.set(key, intent.actorId);
          decisions.push(Object.freeze({ intent, reason: "accepted", status: "accepted" }));
        } else {
          decisions.push(decision(intent, "blocked"));
        }
      }
    }
    return Object.freeze(
      decisions.sort((left, right) => compareMovementIntent(left.intent, right.intent)),
    );
  }
}

/** The sole authority that admits at most one primary action per creep each tick. */
export class CreepActionArbiter {
  public arbitrate(
    tick: number,
    actorIds: ReadonlySet<string>,
    targetIds: ReadonlySet<string>,
    intents: readonly CreepActionIntent[],
  ): readonly CreepActionDecision[] {
    const selected = new Set<string>();
    return Object.freeze(
      intents
        .slice()
        .sort(compareActionIntent)
        .map((intent) => {
          if (!actorIds.has(intent.actorId)) {
            return Object.freeze({ intent, reason: "stale-actor", status: "rejected" as const });
          }
          if (!targetIds.has(intent.targetId)) {
            return Object.freeze({ intent, reason: "stale-target", status: "rejected" as const });
          }
          if (tick > intent.deadline) {
            return Object.freeze({ intent, reason: "expired", status: "rejected" as const });
          }
          if (selected.has(intent.actorId)) {
            return Object.freeze({ intent, reason: "actor-conflict", status: "rejected" as const });
          }
          selected.add(intent.actorId);
          return Object.freeze({ intent, reason: "accepted", status: "accepted" as const });
        }),
    );
  }
}

function decision(intent: MovementIntent, reason: MovementDecision["reason"]): MovementDecision {
  return Object.freeze({ intent, reason, status: "rejected" });
}

function isValidIntent(intent: MovementIntent, actor: MovementActor, tick: number): boolean {
  return (
    tick <= intent.deadline &&
    intent.direction !== null &&
    intent.range >= 0 &&
    intent.destination.roomName === actor.pos.roomName &&
    intent.goal.roomName === actor.pos.roomName
  );
}

function permitsSwap(
  intent: MovementIntent,
  current: MovementIntent | undefined,
  actors: ReadonlyMap<string, MovementActor>,
): boolean {
  if (current === undefined) return false;
  const actor = actors.get(intent.actorId);
  const currentActor = actors.get(current.actorId);
  return (
    actor !== undefined &&
    currentActor !== undefined &&
    positionKey(intent.destination) === positionKey(currentActor.pos) &&
    positionKey(current.destination) === positionKey(actor.pos)
  );
}

function compareMovementIntent(left: MovementIntent, right: MovementIntent): number {
  return (
    right.priority - left.priority ||
    left.deadline - right.deadline ||
    right.stuckAge - left.stuckAge ||
    compareStrings(left.actorId, right.actorId) ||
    compareStrings(left.id, right.id)
  );
}

function compareActionIntent(left: CreepActionIntent, right: CreepActionIntent): number {
  return (
    right.priority - left.priority ||
    left.deadline - right.deadline ||
    compareStrings(left.id, right.id)
  );
}

function positionKey(position: {
  readonly roomName: string;
  readonly x: number;
  readonly y: number;
}): string {
  return `${position.roomName}:${String(position.x)}:${String(position.y)}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
