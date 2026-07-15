import type { NormalizedCommandOutcome } from "../execution";
import type { PositionSnapshot } from "../world/snapshot";

export type MovementDecisionReason =
  "accepted" | "blocked" | "fatigued" | "invalid-goal" | "no-path" | "stale-actor";

export interface MovementIntent {
  readonly actorId: string;
  /** Nullable only for non-contract producers; pairs action evidence with the leased authority. */
  readonly contractId: string | null;
  readonly contractRevision: number | null;
  readonly deadline: number;
  readonly destination: PositionSnapshot;
  readonly direction: DirectionConstant | null;
  readonly goal: PositionSnapshot;
  readonly id: string;
  readonly priority: number;
  readonly range: number;
  readonly stuckAge: number;
}

export interface MovementActor {
  readonly fatigue: number;
  readonly id: string;
  readonly pos: PositionSnapshot;
}

export interface MovementDecision {
  readonly intent: MovementIntent;
  readonly reason: MovementDecisionReason;
  readonly status: "accepted" | "rejected";
}

export interface MovementExecutionResult {
  readonly intent: MovementIntent;
  readonly outcome: NormalizedCommandOutcome | null;
  readonly reason: MovementDecisionReason | "adapter-fault" | "invalid-return-code";
  readonly status: "executed" | "failed" | "rejected";
}

export type CreepActionKind =
  "build" | "harvest" | "pickup" | "repair" | "transfer" | "upgrade-controller" | "withdraw";

export interface CreepActionIntent {
  readonly actorId: string;
  readonly amount: number | null;
  /** Nullable only for non-contract producers; pairs action evidence with the leased authority. */
  readonly contractId: string | null;
  readonly contractRevision: number | null;
  readonly deadline: number;
  readonly id: string;
  readonly kind: CreepActionKind;
  readonly priority: number;
  readonly resourceType: ResourceConstant | null;
  readonly targetId: string;
}

export interface CreepActionDecision {
  readonly intent: CreepActionIntent;
  readonly reason: "accepted" | "actor-conflict" | "expired" | "stale-actor" | "stale-target";
  readonly status: "accepted" | "rejected";
}

export interface CreepActionExecutionResult {
  readonly intent: CreepActionIntent;
  readonly outcome: NormalizedCommandOutcome | null;
  readonly reason:
    | "adapter-fault"
    | "invalid-return-code"
    | "out-of-range"
    | "stale-actor"
    | "stale-target"
    | "tired"
    | "unexpected-game-rejection"
    | "executed";
  readonly status: "executed" | "failed" | "rejected";
}

/** Immutable per-tick evidence produced after the movement buffers are sealed. */
export interface MovementRuntimeResult {
  readonly actionDecisions: readonly CreepActionDecision[];
  readonly actionExecution: readonly CreepActionExecutionResult[];
  readonly actionSubmitted: number;
  readonly movementDecisions: readonly MovementDecision[];
  readonly movementExecution: readonly MovementExecutionResult[];
  readonly movementSubmitted: number;
  readonly status: "disabled" | "executed" | "not-run";
}
