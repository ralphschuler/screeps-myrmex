import type { WorldSnapshot } from "../world/snapshot";
import { CreepActionArbiter, MovementArbiter } from "./arbiter";
import type { CreepActionIntent, MovementIntent, MovementRuntimeResult } from "./contracts";
import {
  CreepActionExecutor,
  MovementExecutor,
  type ActionActor,
  type MoveActor,
} from "./executor";

const MAXIMUM_ACTIONS = 128;
const MAXIMUM_MOVEMENTS = 128;

export interface MovementIntentProducer {
  submit(intent: MovementIntent): void;
}

export interface CreepActionIntentProducer {
  submit(intent: CreepActionIntent): void;
}

/** Capabilities exposed to planning systems; neither capability can issue a Screeps command. */
export interface MovementRuntimeChannels {
  readonly actions: CreepActionIntentProducer;
  readonly movement: MovementIntentProducer;
}

export interface MovementRuntimeResolvers {
  readonly resolveActor: (actorId: string) => unknown;
  readonly resolveTarget: (targetId: string) => unknown;
}

/**
 * Owns the bounded tick-local producer buffers. Agents will receive the producers in #38; no
 * planner receives executors or live game objects.
 */
export class MovementRuntime {
  private readonly movement: MovementIntent[] = [];
  private readonly actions: CreepActionIntent[] = [];
  private sealed = false;

  public readonly movementProducer: MovementIntentProducer = Object.freeze({
    submit: (intent: MovementIntent): void => {
      this.submitMovement(intent);
    },
  });

  public readonly actionProducer: CreepActionIntentProducer = Object.freeze({
    submit: (intent: CreepActionIntent): void => {
      this.submitAction(intent);
    },
  });

  public readonly channels: MovementRuntimeChannels = Object.freeze({
    actions: this.actionProducer,
    movement: this.movementProducer,
  });

  public execute(
    snapshot: WorldSnapshot,
    tick: number,
    resolvers: MovementRuntimeResolvers,
  ): MovementRuntimeResult {
    this.sealed = true;
    const actors = snapshot.rooms.flatMap((room) =>
      room.ownedCreeps.map(({ fatigue, id, pos }) => ({ fatigue, id, pos })),
    );
    const actorIds = new Set(actors.map(({ id }) => id));
    const targetIds = collectTargetIds(snapshot);
    const movementDecisions = new MovementArbiter().arbitrate(tick, actors, this.movement);
    const actionDecisions = new CreepActionArbiter().arbitrate(
      tick,
      actorIds,
      targetIds,
      this.actions,
    );
    const movementExecution = new MovementExecutor().execute(
      movementDecisions,
      (actorId) => safelyResolve(resolvers.resolveActor, actorId) as MoveActor | null,
    );
    const actionExecution = new CreepActionExecutor().execute(
      actionDecisions,
      (actorId) => safelyResolve(resolvers.resolveActor, actorId) as ActionActor | null,
      (targetId) => safelyResolve(resolvers.resolveTarget, targetId),
    );
    return Object.freeze({
      actionDecisions,
      actionExecution,
      actionSubmitted: this.actions.length,
      movementDecisions,
      movementExecution,
      movementSubmitted: this.movement.length,
      status: "executed",
    });
  }

  public disabled(): MovementRuntimeResult {
    this.sealed = true;
    return emptyMovementRuntimeResult("disabled");
  }

  private submitMovement(intent: MovementIntent): void {
    this.assertOpen();
    if (this.movement.length >= MAXIMUM_MOVEMENTS)
      throw new Error("movement buffer capacity exceeded");
    this.movement.push(Object.freeze({ ...intent }));
  }

  private submitAction(intent: CreepActionIntent): void {
    this.assertOpen();
    if (this.actions.length >= MAXIMUM_ACTIONS) throw new Error("action buffer capacity exceeded");
    this.actions.push(Object.freeze({ ...intent }));
  }

  private assertOpen(): void {
    if (this.sealed) throw new Error("movement runtime buffers are sealed");
  }
}

export function emptyMovementRuntimeResult(
  status: MovementRuntimeResult["status"] = "not-run",
): MovementRuntimeResult {
  return Object.freeze({
    actionDecisions: Object.freeze([]),
    actionExecution: Object.freeze([]),
    actionSubmitted: 0,
    movementDecisions: Object.freeze([]),
    movementExecution: Object.freeze([]),
    movementSubmitted: 0,
    status,
  });
}

function collectTargetIds(snapshot: WorldSnapshot): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const room of snapshot.rooms) {
    if (room.controller !== null) ids.add(room.controller.id);
    for (const item of [
      ...room.constructionSites,
      ...room.hostileCreeps,
      ...room.ownedCreeps,
      ...room.ownedExtensions,
      ...room.ownedSpawns,
      ...room.ownedTowers,
      ...room.sources,
      ...room.storedStructures,
    ])
      ids.add(item.id);
  }
  return ids;
}

function safelyResolve(resolver: (id: string) => unknown, id: string): unknown {
  try {
    return resolver(id);
  } catch {
    return null;
  }
}
