import type {
  ContractExecutionView,
  ContractTransitionRequest,
  LeasedWorkExecution,
} from "../contracts";
import type { LocalPathPlanningService } from "../movement/path-cache";
import type { CreepActionIntent, MovementIntent } from "../movement/contracts";
import type {
  CreepSnapshot,
  PositionSnapshot,
  StoreSnapshot,
  WorldSnapshot,
} from "../world/snapshot";

export const MAX_LEASE_AGENT_ACTORS = 64;

export type AgentDispositionReason =
  | "actor-capability-lost"
  | "actor-missing"
  | "actor-spawning"
  | "actor-store-empty"
  | "actor-store-full"
  | "actor-ttl-insufficient"
  | "contract-expired"
  | "path-unavailable"
  | "work-position-invalid"
  | "target-depleted"
  | "target-full"
  | "target-missing"
  | "work-complete";

export interface LeaseAgentDisposition {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly reason: AgentDispositionReason;
  readonly to: "completed" | "suspended";
}

export interface LeaseAgentPlan {
  readonly actions: readonly CreepActionIntent[];
  readonly dispositions: readonly LeaseAgentDisposition[];
  readonly movement: readonly MovementIntent[];
}

export interface LeaseAgentPlanInput {
  readonly availablePathCpu: number;
  readonly execution: ContractExecutionView;
  readonly paths: LocalPathPlanningService;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
}

/**
 * Pure per-tick lease translation. Contract state is the sole durable progress authority: this
 * function derives approach/action from the current immutable snapshot, so a heap reset has no
 * actor-local task state to recover.
 */
export function planLeaseAgents(input: LeaseAgentPlanInput): LeaseAgentPlan {
  if (input.execution.status !== "ready") return emptyPlan();
  const actors = actorIndex(input.snapshot);
  const targets = targetIndex(input.snapshot);
  const actions: CreepActionIntent[] = [];
  const movement: MovementIntent[] = [];
  const dispositions: LeaseAgentDisposition[] = [];
  const seenActors = new Set<string>();
  const leases = input.execution.leases
    .slice()
    .sort(
      (left, right) =>
        compareStrings(left.actorId, right.actorId) ||
        compareStrings(left.contractId, right.contractId),
    );

  for (
    let index = 0;
    index < leases.length && seenActors.size < MAX_LEASE_AGENT_ACTORS;
    index += 1
  ) {
    const lease = leases[index];
    if (lease === undefined || seenActors.has(lease.actorId)) continue;
    seenActors.add(lease.actorId);
    const actor = actors.get(lease.actorId);
    const disposition = validateLease(lease, actor, targets, input.tick);
    if (disposition !== null) {
      dispositions.push(disposition);
      continue;
    }
    if (actor === undefined) continue;
    const target = targets.get(lease.targetId);
    if (target === undefined) continue;
    if (lease.execution.version === 2 && target.amount === 0) continue;
    const goal = lease.execution.version === 2 ? lease.execution.workPosition : target.pos;
    const range = lease.execution.version === 2 ? 0 : lease.range;
    if (inRange(actor.pos, goal, range)) {
      if (lease.execution.version === 2 && !inRange(actor.pos, target.pos, 1)) {
        dispositions.push({
          contractId: lease.contractId,
          contractRevision: lease.revision,
          reason: "work-position-invalid",
          to: "suspended",
        });
        continue;
      }
      actions.push(actionIntent(lease));
      continue;
    }
    const path = input.paths.plan({
      availableCpu: Math.max(0, input.availablePathCpu - index * 0.5),
      goal,
      origin: actor.pos,
      range,
      snapshot: input.snapshot,
      tick: input.tick,
    });
    if (path.status !== "ready" || path.directions[0] === undefined) {
      dispositions.push({
        contractId: lease.contractId,
        contractRevision: lease.revision,
        reason: "path-unavailable",
        to: "suspended",
      });
      continue;
    }
    const direction = path.directions[0];
    const destination = nextPosition(actor.pos, direction);
    if (destination === null) {
      dispositions.push({
        contractId: lease.contractId,
        contractRevision: lease.revision,
        reason: "path-unavailable",
        to: "suspended",
      });
      continue;
    }
    movement.push({
      actorId: actor.id,
      contractId: lease.contractId,
      contractRevision: lease.revision,
      deadline: actionDeadline(lease),
      destination,
      direction,
      goal,
      id: `lease:${lease.contractId}:r${String(lease.revision)}:move`,
      priority: lease.priority.value,
      range,
      stuckAge: 0,
    });
  }
  return Object.freeze({
    actions: Object.freeze(actions),
    dispositions: Object.freeze(dispositions),
    movement: Object.freeze(movement),
  });
}

export function dispositionTransitions(
  dispositions: readonly LeaseAgentDisposition[],
  tick: number,
): readonly ContractTransitionRequest[] {
  return Object.freeze(
    dispositions
      .slice()
      .sort((left, right) => compareStrings(left.contractId, right.contractId))
      .map(({ contractId, reason, to }) => ({ contractId, reason: `agent-${reason}`, tick, to })),
  );
}

function emptyPlan(): LeaseAgentPlan {
  return Object.freeze({
    actions: Object.freeze([]),
    dispositions: Object.freeze([]),
    movement: Object.freeze([]),
  });
}

function actorIndex(snapshot: WorldSnapshot): ReadonlyMap<string, CreepSnapshot> {
  return new Map(
    snapshot.rooms.flatMap((room) => room.ownedCreeps).map((actor) => [actor.id, actor]),
  );
}

interface TargetView {
  readonly amount: number | null;
  readonly hits: number | null;
  readonly hitsMax: number | null;
  readonly id: string;
  readonly pos: PositionSnapshot;
  readonly store: StoreSnapshot | null;
  readonly type:
    | "construction"
    | "controller"
    | "creep"
    | "resource"
    | "ruin"
    | "source"
    | "structure"
    | "tombstone";
}

function targetIndex(snapshot: WorldSnapshot): ReadonlyMap<string, TargetView> {
  const targets: TargetView[] = [];
  for (const room of snapshot.rooms) {
    if (room.controller !== null)
      targets.push({
        amount: null,
        hits: null,
        hitsMax: null,
        id: room.controller.id,
        pos: room.controller.pos,
        store: null,
        type: "controller",
      });
    for (const source of room.sources)
      targets.push({
        amount: source.energy,
        hits: null,
        hitsMax: null,
        id: source.id,
        pos: source.pos,
        store: null,
        type: "source",
      });
    for (const resource of room.droppedResources ?? [])
      targets.push({
        amount: resource.amount,
        hits: null,
        hitsMax: null,
        id: resource.id,
        pos: resource.pos,
        store: null,
        type: "resource",
      });
    for (const ruin of room.ruins ?? [])
      targets.push({
        amount: null,
        hits: null,
        hitsMax: null,
        id: ruin.id,
        pos: ruin.pos,
        store: ruin.store,
        type: "ruin",
      });
    for (const tombstone of room.tombstones ?? [])
      targets.push({
        amount: null,
        hits: null,
        hitsMax: null,
        id: tombstone.id,
        pos: tombstone.pos,
        store: tombstone.store,
        type: "tombstone",
      });
    for (const site of room.constructionSites)
      targets.push({
        amount: site.progressTotal - site.progress,
        hits: null,
        hitsMax: null,
        id: site.id,
        pos: site.pos,
        store: null,
        type: "construction",
      });
    for (const creep of [...room.ownedCreeps, ...room.hostileCreeps])
      targets.push({
        amount: null,
        hits: creep.hits,
        hitsMax: creep.hitsMax,
        id: creep.id,
        pos: creep.pos,
        store: creep.store,
        type: "creep",
      });
    for (const structure of room.storedStructures)
      targets.push({
        amount: null,
        hits: structure.hits,
        hitsMax: structure.hitsMax,
        id: structure.id,
        pos: structure.pos,
        store: structure.store,
        type: "structure",
      });
    for (const structure of [...room.ownedExtensions, ...room.ownedSpawns, ...room.ownedTowers])
      targets.push({
        amount: null,
        hits: structure.hits,
        hitsMax: structure.hitsMax,
        id: structure.id,
        pos: structure.pos,
        store: structure.store,
        type: "structure",
      });
  }
  targets.sort((left, right) => compareStrings(left.id, right.id));
  return new Map(targets.map((target) => [target.id, target]));
}

function validateLease(
  lease: LeasedWorkExecution,
  actor: CreepSnapshot | undefined,
  targets: ReadonlyMap<string, TargetView>,
  tick: number,
): LeaseAgentDisposition | null {
  const suspend = (reason: AgentDispositionReason): LeaseAgentDisposition => ({
    contractId: lease.contractId,
    contractRevision: lease.revision,
    reason,
    to: "suspended",
  });
  if (tick > actionDeadline(lease)) return suspend("contract-expired");
  if (actor === undefined || actor.name !== lease.actorName) return suspend("actor-missing");
  if (actor.spawning) return suspend("actor-spawning");
  if (actor.ticksToLive === null || actor.ticksToLive <= 1)
    return suspend("actor-ttl-insufficient");
  const target = targets.get(lease.targetId);
  if (target === undefined || !samePosition(target.pos, lease.target))
    return suspend("target-missing");
  if (!canPerform(actor, lease.execution.action)) return suspend("actor-capability-lost");
  const resource = lease.execution.resourceType;
  const carried = resource === null ? 0 : resourceAmount(actor.store, resource);
  if (needsEnergy(lease.execution.action) && resourceAmount(actor.store, "energy") <= 0)
    return suspend("actor-store-empty");
  if (
    (lease.execution.action === "transfer" || lease.execution.action === "withdraw") &&
    resource === null
  )
    return suspend("actor-store-empty");
  if (
    (lease.execution.action === "transfer" || lease.execution.action === "withdraw") &&
    carried <= 0 &&
    lease.execution.action === "transfer"
  )
    return suspend("actor-store-empty");
  if (
    (lease.execution.action === "harvest" ||
      lease.execution.action === "withdraw" ||
      lease.execution.action === "pickup") &&
    actor.store.freeCapacity !== null &&
    actor.store.freeCapacity <= 0
  )
    return suspend("actor-store-full");
  if (lease.execution.action === "harvest" && target.type !== "source")
    return unavailableTarget(lease, suspend, "target-depleted");
  if (lease.execution.action === "harvest" && target.amount === 0)
    return lease.execution.version === 2
      ? null
      : unavailableTarget(lease, suspend, "target-depleted");
  if (
    lease.execution.action === "transfer" &&
    (target.store === null || target.store.freeCapacity === 0)
  )
    return unavailableTarget(lease, suspend, "target-full");
  if (
    lease.execution.action === "withdraw" &&
    (target.store === null || resource === null || resourceAmount(target.store, resource) === 0)
  )
    return unavailableTarget(lease, suspend, "target-depleted");
  if (lease.execution.action === "build" && (target.type !== "construction" || target.amount === 0))
    return completion(lease, "work-complete");
  if (
    lease.execution.action === "repair" &&
    (target.hits === null ||
      target.hitsMax === null ||
      target.hits >= (lease.execution.completionHits ?? target.hitsMax))
  )
    return completion(lease, "work-complete");
  if (lease.execution.action === "upgrade-controller" && target.type !== "controller")
    return suspend("target-missing");
  if (lease.execution.action === "pickup" && (target.type !== "resource" || target.amount === 0))
    return completion(lease, "target-depleted");
  return null;
}

function unavailableTarget(
  lease: LeasedWorkExecution,
  suspend: (reason: AgentDispositionReason) => LeaseAgentDisposition,
  reason: Extract<AgentDispositionReason, "target-depleted" | "target-full">,
): LeaseAgentDisposition {
  return lease.execution.completion === "continuous" ? suspend(reason) : completion(lease, reason);
}

function completion(
  lease: LeasedWorkExecution,
  reason: Extract<AgentDispositionReason, "target-depleted" | "target-full" | "work-complete">,
): LeaseAgentDisposition {
  return {
    contractId: lease.contractId,
    contractRevision: lease.revision,
    reason,
    to: lease.state === "active" ? "completed" : "suspended",
  };
}

function canPerform(
  actor: CreepSnapshot,
  action: LeasedWorkExecution["execution"]["action"],
): boolean {
  if (action === "transfer" || action === "withdraw" || action === "pickup")
    return actor.body.carry.active > 0;
  return actor.body.work.active > 0 && (action === "harvest" || actor.body.carry.active > 0);
}

function needsEnergy(action: LeasedWorkExecution["execution"]["action"]): boolean {
  return action === "build" || action === "repair" || action === "upgrade-controller";
}

function actionIntent(lease: LeasedWorkExecution): CreepActionIntent {
  return {
    actorId: lease.actorId,
    // A continuous fill lease owns a sink slot, not one energy unit. Omitting the Screeps amount
    // transfers the assigned actor's available cargo without conflating contract quantity with a
    // resource amount.
    amount:
      lease.execution.action === "transfer" && lease.execution.completion === "continuous"
        ? null
        : lease.quantity,
    contractId: lease.contractId,
    contractRevision: lease.revision,
    deadline: actionDeadline(lease),
    id: `lease:${lease.contractId}:r${String(lease.revision)}:action`,
    kind: lease.execution.action,
    priority: lease.priority.value,
    resourceType: lease.execution.resourceType,
    targetId: lease.targetId,
  };
}

function actionDeadline(lease: LeasedWorkExecution): number {
  return Math.min(lease.deadline, lease.expiresAt - 1, lease.leaseExpiresAt - 1);
}

function resourceAmount(store: StoreSnapshot, resourceType: string): number {
  return store.resources.find((resource) => resource.resourceType === resourceType)?.amount ?? 0;
}

function inRange(left: PositionSnapshot, right: PositionSnapshot, range: number): boolean {
  return (
    left.roomName === right.roomName &&
    Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) <= range
  );
}

function samePosition(left: PositionSnapshot, right: PositionSnapshot): boolean {
  return left.roomName === right.roomName && left.x === right.x && left.y === right.y;
}

function nextPosition(
  origin: PositionSnapshot,
  direction: DirectionConstant,
): PositionSnapshot | null {
  const deltas: Readonly<Record<number, readonly [number, number]>> = {
    1: [0, -1],
    2: [1, -1],
    3: [1, 0],
    4: [1, 1],
    5: [0, 1],
    6: [-1, 1],
    7: [-1, 0],
    8: [-1, -1],
  };
  const delta = deltas[direction];
  if (delta === undefined) return null;
  const x = origin.x + delta[0];
  const y = origin.y + delta[1];
  return x >= 0 && x <= 49 && y >= 0 && y <= 49 ? { roomName: origin.roomName, x, y } : null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
