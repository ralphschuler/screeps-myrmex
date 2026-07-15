import { normalizeScreepsReturnCode } from "../execution";
import type {
  CreepActionDecision,
  CreepActionExecutionResult,
  CreepActionIntent,
  MovementDecision,
  MovementExecutionResult,
} from "./contracts";

export interface MoveActor {
  move(direction: DirectionConstant): number;
}
export interface ActionActor {
  build(target: ConstructionSite): number;
  harvest(target: Source | Mineral | Deposit): number;
  pickup(target: Resource): number;
  repair(target: Structure): number;
  transfer(
    target: Creep | PowerCreep | Structure,
    resource: ResourceConstant,
    amount?: number,
  ): number;
  upgradeController(target: StructureController): number;
  withdraw(
    target: Structure | Tombstone | Ruin,
    resource: ResourceConstant,
    amount?: number,
  ): number;
}

/** The sole caller of Creep.move. It converts all expected engine outcomes into typed data. */
export class MovementExecutor {
  public execute(
    decisions: readonly MovementDecision[],
    resolveActor: (actorId: string) => MoveActor | null,
  ): readonly MovementExecutionResult[] {
    return Object.freeze(decisions.map((decision) => this.executeOne(decision, resolveActor)));
  }

  private executeOne(
    decision: MovementDecision,
    resolveActor: (actorId: string) => MoveActor | null,
  ): MovementExecutionResult {
    if (decision.status === "rejected")
      return Object.freeze({
        intent: decision.intent,
        outcome: null,
        reason: decision.reason,
        status: "rejected",
      });
    const actor = safelyResolve(resolveActor, decision.intent.actorId);
    if (actor === null || decision.intent.direction === null)
      return Object.freeze({
        intent: decision.intent,
        outcome: null,
        reason: "stale-actor",
        status: "rejected",
      });
    try {
      const outcome = normalizeScreepsReturnCode(actor.move(decision.intent.direction));
      return Object.freeze({
        intent: decision.intent,
        outcome,
        reason:
          outcome.state === "scheduled"
            ? "accepted"
            : outcome.state === "game-rejected"
              ? "blocked"
              : outcome.state,
        status: outcome.state === "scheduled" ? "executed" : "failed",
      });
    } catch {
      return Object.freeze({
        intent: decision.intent,
        outcome: null,
        reason: "adapter-fault",
        status: "failed",
      });
    }
  }
}

/** The sole caller of the scoped primary creep actions. */
export class CreepActionExecutor {
  public execute(
    decisions: readonly CreepActionDecision[],
    resolveActor: (actorId: string) => ActionActor | null,
    resolveTarget: (targetId: string) => unknown,
  ): readonly CreepActionExecutionResult[] {
    return Object.freeze(
      decisions.map((decision) => this.executeOne(decision, resolveActor, resolveTarget)),
    );
  }

  private executeOne(
    decision: CreepActionDecision,
    resolveActor: (actorId: string) => ActionActor | null,
    resolveTarget: (targetId: string) => unknown,
  ): CreepActionExecutionResult {
    if (decision.status === "rejected")
      return Object.freeze({
        intent: decision.intent,
        outcome: null,
        reason: decision.reason === "stale-target" ? "stale-target" : "stale-actor",
        status: "rejected",
      });
    const actor = safelyResolve(resolveActor, decision.intent.actorId);
    const target = safelyResolve(resolveTarget, decision.intent.targetId);
    if (actor === null)
      return Object.freeze({
        intent: decision.intent,
        outcome: null,
        reason: "stale-actor",
        status: "rejected",
      });
    if (target === null)
      return Object.freeze({
        intent: decision.intent,
        outcome: null,
        reason: "stale-target",
        status: "rejected",
      });
    try {
      const outcome = normalizeScreepsReturnCode(issueAction(actor, target, decision.intent));
      return Object.freeze({
        intent: decision.intent,
        outcome,
        reason: actionReason(outcome),
        status: outcome.state === "scheduled" ? "executed" : "rejected",
      });
    } catch {
      return Object.freeze({
        intent: decision.intent,
        outcome: null,
        reason: "adapter-fault",
        status: "failed",
      });
    }
  }
}

function issueAction(actor: ActionActor, target: unknown, intent: CreepActionIntent): number {
  switch (intent.kind) {
    case "build":
      return actor.build(target as ConstructionSite);
    case "harvest":
      return actor.harvest(target as Source | Mineral | Deposit);
    case "pickup":
      return actor.pickup(target as Resource);
    case "repair":
      return actor.repair(target as Structure);
    case "transfer":
      return actor.transfer(
        target as Creep | PowerCreep | Structure,
        requiredResource(intent),
        optionalAmount(intent),
      );
    case "upgrade-controller":
      return actor.upgradeController(target as StructureController);
    case "withdraw":
      return actor.withdraw(
        target as Structure | Tombstone | Ruin,
        requiredResource(intent),
        optionalAmount(intent),
      );
  }
}

function requiredResource(intent: CreepActionIntent): ResourceConstant {
  if (intent.resourceType === null) throw new Error("resource action requires a resource type");
  return intent.resourceType;
}
function optionalAmount(intent: CreepActionIntent): number | undefined {
  return intent.amount === null ? undefined : intent.amount;
}
function actionReason(
  outcome: ReturnType<typeof normalizeScreepsReturnCode>,
): CreepActionExecutionResult["reason"] {
  if (outcome.state === "scheduled") return "executed";
  if (outcome.state !== "game-rejected") return outcome.state;
  if (outcome.name === "ERR_NOT_IN_RANGE") return "out-of-range";
  if (outcome.name === "ERR_TIRED") return "tired";
  return "unexpected-game-rejection";
}

function safelyResolve<T>(resolver: (id: string) => T | null, id: string): T | null {
  try {
    return resolver(id);
  } catch {
    return null;
  }
}
