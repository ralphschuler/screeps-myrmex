import {
  MAX_LEASE_EXECUTION_ACTORS,
  type ContractExecutionTerms,
  type ContractExecutionView,
  type ContractTransitionRequest,
  type LeaseTravelOverride,
  type LeasedWorkExecution,
} from "../contracts";
import type { MovementPolicy } from "../config";
import {
  LOCAL_PATH_SEARCH_CPU_ESTIMATE,
  MAX_DYNAMIC_MOVEMENT_BLOCKERS,
  type LocalPathPlanningService,
  type LocalPathPlanResult,
} from "../movement/path-cache";
import type { CreepActionIntent, MovementIntent } from "../movement/contracts";
import type { MovementProgressView } from "../movement/progress";
import type {
  CreepSnapshot,
  PositionSnapshot,
  StoreSnapshot,
  WorldSnapshot,
} from "../world/snapshot";

export const MAX_LEASE_AGENT_ACTORS = MAX_LEASE_EXECUTION_ACTORS;

export type AgentDispositionReason =
  | "actor-capability-lost"
  | "actor-missing"
  | "actor-spawning"
  | "actor-store-empty"
  | "actor-store-full"
  | "actor-ttl-insufficient"
  | "contract-expired"
  | "controller-blocked"
  | "movement-blocked"
  | "path-unavailable"
  | "route-unavailable"
  | "work-position-invalid"
  | "target-depleted"
  | "target-full"
  | "target-missing"
  | "travel-override-complete"
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
  readonly movementPolicy: MovementPolicy;
  readonly paths: LocalPathPlanningService;
  readonly progress: MovementProgressView;
  readonly snapshot: WorldSnapshot;
  readonly tick: number;
  readonly travelOverrides?: readonly LeaseTravelOverride[];
}

/**
 * Pure per-tick lease translation. Contract state is the sole durable progress authority: this
 * function derives approach/action from the current immutable snapshot, so a heap reset has no
 * actor-local task state to recover.
 */
export function planLeaseAgents(input: LeaseAgentPlanInput): LeaseAgentPlan {
  if (input.execution.status !== "ready") return emptyPlan();
  const overrides = travelOverrideIndex(input.travelOverrides ?? [], input.execution.leases);
  if (overrides === null) return emptyPlan();
  const actors = actorIndex(input.snapshot);
  const targets = targetIndex(input.snapshot);
  const actions: CreepActionIntent[] = [];
  const movement: MovementIntent[] = [];
  const dispositions: LeaseAgentDisposition[] = [];
  const seenActors = new Set<string>();
  let remainingPathCpu = Math.max(0, input.availablePathCpu);
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
    const override = overrides.get(lease.contractId);
    // Lease expiry is allocator evidence, not contract failure. Emit nothing after the exclusive
    // lease boundary and let ContractLedger release/reassign it in the same Reconcile pass. Actual
    // contract/override expiry still follows the normal suspension path below.
    if (
      override === undefined &&
      input.tick >= lease.leaseExpiresAt &&
      input.tick <= lease.deadline &&
      input.tick < lease.expiresAt
    )
      continue;
    const disposition =
      override === undefined
        ? validateLease(lease, actor, targets, input.tick)
        : validateTravelOverride(lease, override, actor, input.tick);
    if (disposition !== null) {
      dispositions.push(disposition);
      continue;
    }
    if (actor === undefined) continue;
    if (override?.mode === "hold") continue;
    const target = targets.get(lease.targetId);
    const route = override ?? executionRoute(lease.execution);
    const destinationRoomName = override?.destinationRoomName ?? lease.target.roomName;
    if (override !== undefined && actor.pos.roomName === destinationRoomName) {
      dispositions.push({
        contractId: lease.contractId,
        contractRevision: lease.revision,
        reason: "travel-override-complete",
        to: "suspended",
      });
      continue;
    }
    const routeStep =
      route !== null && actor.pos.roomName !== destinationRoomName
        ? crossRoomStep(route, actor.pos, input.snapshot)
        : null;
    if (route !== null && actor.pos.roomName !== destinationRoomName) {
      if (routeStep === null) {
        dispositions.push({
          contractId: lease.contractId,
          contractRevision: lease.revision,
          reason: "route-unavailable",
          to: "suspended",
        });
        continue;
      }
      if (samePosition(actor.pos, routeStep.exit)) {
        const stuckAge = input.progress.stuckAge({
          actorId: actor.id,
          actorPosition: actor.pos,
          contractId: lease.contractId,
          contractRevision: lease.revision,
          goal: routeStep.destination,
          range: 0,
          tick: input.tick,
        });
        if (stuckAge >= input.movementPolicy.blockedReleaseTicks) {
          dispositions.push({
            contractId: lease.contractId,
            contractRevision: lease.revision,
            reason: "movement-blocked",
            to: "suspended",
          });
        } else {
          movement.push(
            movementIntent(
              lease,
              routeStep.destination,
              routeStep.direction,
              routeStep.destination,
              0,
              stuckAge,
              true,
              override?.priority,
              override?.deadline,
            ),
          );
        }
        continue;
      }
    }
    if (target === undefined && routeStep === null) continue;
    const goal =
      routeStep?.exit ??
      (override === undefined
        ? isStaticMiningExecution(lease.execution)
          ? lease.execution.workPosition
          : target?.pos
        : undefined);
    if (goal === undefined) continue;
    const range =
      routeStep === null ? (isStaticMiningExecution(lease.execution) ? 0 : lease.range) : 0;
    if (inRange(actor.pos, goal, range)) {
      if (target === undefined) continue;
      if (isStaticMiningExecution(lease.execution) && !inRange(actor.pos, target.pos, 1)) {
        dispositions.push({
          contractId: lease.contractId,
          contractRevision: lease.revision,
          reason: "work-position-invalid",
          to: "suspended",
        });
        continue;
      }
      if (isStaticMiningExecution(lease.execution) && target.amount === 0) continue;
      actions.push(actionIntent(lease, actor, target));
      continue;
    }
    let path = input.paths.plan({
      availableCpu: remainingPathCpu,
      goal,
      origin: actor.pos,
      range,
      snapshot: input.snapshot,
      tick: input.tick,
    });
    remainingPathCpu = afterPathSearch(remainingPathCpu, path);
    if (path.status !== "ready" || path.directions[0] === undefined) {
      dispositions.push({
        contractId: lease.contractId,
        contractRevision: lease.revision,
        reason: "path-unavailable",
        to: "suspended",
      });
      continue;
    }
    const stuckAge = input.progress.stuckAge({
      actorId: actor.id,
      actorPosition: actor.pos,
      contractId: lease.contractId,
      contractRevision: lease.revision,
      goal,
      range,
      tick: input.tick,
    });
    if (stuckAge >= input.movementPolicy.blockedReleaseTicks) {
      dispositions.push({
        contractId: lease.contractId,
        contractRevision: lease.revision,
        reason: "movement-blocked",
        to: "suspended",
      });
      continue;
    }
    if (stuckAge >= input.movementPolicy.stuckReplanTicks) {
      const blockedPositions = dynamicMovementBlockers(input.snapshot, actor.id, movement);
      if (blockedPositions === null) {
        movement.push(
          movementIntent(
            lease,
            actor.pos,
            null,
            goal,
            range,
            stuckAge,
            false,
            override?.priority,
            override?.deadline,
          ),
        );
        continue;
      }
      const replanned = input.paths.plan({
        availableCpu: remainingPathCpu,
        blockedPositions,
        bypassCache: true,
        goal,
        origin: actor.pos,
        range,
        snapshot: input.snapshot,
        tick: input.tick,
      });
      remainingPathCpu = afterPathSearch(remainingPathCpu, replanned);
      // CPU denial reduces route quality only; the already-authorized cached move remains safe.
      if (replanned.status !== "deferred") {
        if (replanned.status !== "ready" || replanned.directions[0] === undefined) {
          movement.push(
            movementIntent(
              lease,
              actor.pos,
              null,
              goal,
              range,
              stuckAge,
              false,
              override?.priority,
              override?.deadline,
            ),
          );
          continue;
        }
        path = replanned;
      }
    }
    const direction = firstPathDirection(path);
    const destination = direction === null ? null : nextPosition(actor.pos, direction);
    if (direction === null || destination === null) {
      dispositions.push({
        contractId: lease.contractId,
        contractRevision: lease.revision,
        reason: "path-unavailable",
        to: "suspended",
      });
      continue;
    }
    movement.push(
      movementIntent(
        lease,
        destination,
        direction,
        goal,
        range,
        stuckAge,
        false,
        override?.priority,
        override?.deadline,
      ),
    );
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
  readonly controllerOwnership: "foreign" | "neutral" | "owned" | "reserved" | null;
  readonly controllerReservationUsername: string | null;
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
      targets.push(
        targetView({
          id: room.controller.id,
          pos: room.controller.pos,
          type: "controller",
          controllerOwnership: room.controller.ownership,
          controllerReservationUsername: room.controller.reservationUsername,
        }),
      );
    for (const source of room.sources)
      targets.push(
        targetView({ amount: source.energy, id: source.id, pos: source.pos, type: "source" }),
      );
    for (const resource of room.droppedResources ?? [])
      targets.push(
        targetView({
          amount: resource.amount,
          id: resource.id,
          pos: resource.pos,
          type: "resource",
        }),
      );
    for (const ruin of room.ruins ?? [])
      targets.push(targetView({ id: ruin.id, pos: ruin.pos, store: ruin.store, type: "ruin" }));
    for (const tombstone of room.tombstones ?? [])
      targets.push(
        targetView({
          id: tombstone.id,
          pos: tombstone.pos,
          store: tombstone.store,
          type: "tombstone",
        }),
      );
    for (const site of room.constructionSites)
      targets.push(
        targetView({
          amount: site.progressTotal - site.progress,
          id: site.id,
          pos: site.pos,
          type: "construction",
        }),
      );
    for (const creep of [...room.ownedCreeps, ...room.hostileCreeps])
      targets.push(
        targetView({
          hits: creep.hits,
          hitsMax: creep.hitsMax,
          id: creep.id,
          pos: creep.pos,
          store: creep.store,
          type: "creep",
        }),
      );
    for (const structure of room.storedStructures)
      targets.push(
        targetView({
          hits: structure.hits,
          hitsMax: structure.hitsMax,
          id: structure.id,
          pos: structure.pos,
          store: structure.store,
          type: "structure",
        }),
      );
    for (const structure of [...room.ownedExtensions, ...room.ownedSpawns, ...room.ownedTowers])
      targets.push(
        targetView({
          hits: structure.hits,
          hitsMax: structure.hitsMax,
          id: structure.id,
          pos: structure.pos,
          store: structure.store,
          type: "structure",
        }),
      );
  }
  targets.sort((left, right) => compareStrings(left.id, right.id));
  return new Map(targets.map((target) => [target.id, target]));
}

function targetView(
  value: Pick<TargetView, "id" | "pos" | "type"> & Partial<Omit<TargetView, "id" | "pos" | "type">>,
): TargetView {
  return {
    amount: null,
    controllerOwnership: null,
    controllerReservationUsername: null,
    hits: null,
    hitsMax: null,
    store: null,
    ...value,
  };
}

function travelOverrideIndex(
  values: readonly LeaseTravelOverride[],
  leases: readonly LeasedWorkExecution[],
): ReadonlyMap<string, LeaseTravelOverride> | null {
  if (values.length > MAX_LEASE_AGENT_ACTORS) return null;
  const leasesByContract = new Map(leases.map((lease) => [lease.contractId, lease]));
  const result = new Map<string, LeaseTravelOverride>();
  for (const value of values) {
    const lease = leasesByContract.get(value.contractId);
    if (
      lease === undefined ||
      result.has(value.contractId) ||
      value.actorId !== lease.actorId ||
      value.contractRevision !== lease.revision ||
      !Number.isSafeInteger(value.deadline) ||
      value.deadline < 0 ||
      !Number.isSafeInteger(value.priority) ||
      value.priority < 0 ||
      typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      value.reason.length > 128 ||
      !Array.isArray(value.routeRoomNames) ||
      !validRoomName(value.originRoomName) ||
      !validRoomName(value.destinationRoomName) ||
      !validOverrideRoute(value)
    )
      return null;
    result.set(value.contractId, value);
  }
  return result;
}

function validOverrideRoute(value: LeaseTravelOverride): boolean {
  const mode: unknown = value.mode;
  if (mode === "hold")
    return (
      value.destinationRoomName === value.originRoomName &&
      value.routeTravelTicks === 0 &&
      value.routeRoomNames.length === 0
    );
  if (mode !== "travel") return false;
  return (
    value.destinationRoomName !== value.originRoomName &&
    Number.isSafeInteger(value.routeTravelTicks) &&
    value.routeTravelTicks > 0 &&
    value.routeRoomNames.length > 0 &&
    value.routeRoomNames.length <= 16 &&
    value.routeRoomNames[value.routeRoomNames.length - 1] === value.destinationRoomName &&
    value.routeRoomNames.every(validRoomName)
  );
}

function validateTravelOverride(
  lease: LeasedWorkExecution,
  override: LeaseTravelOverride,
  actor: CreepSnapshot | undefined,
  tick: number,
): LeaseAgentDisposition | null {
  const suspend = (reason: AgentDispositionReason): LeaseAgentDisposition => ({
    contractId: lease.contractId,
    contractRevision: lease.revision,
    reason,
    to: "suspended",
  });
  if (tick > Math.min(actionDeadline(lease), override.deadline)) return suspend("contract-expired");
  if (actor === undefined || actor.name !== lease.actorName) return suspend("actor-missing");
  if (actor.spawning) return suspend("actor-spawning");
  if (actor.ticksToLive === null || actor.ticksToLive <= 1)
    return suspend("actor-ttl-insufficient");
  if (actor.body.move.active <= 0) return suspend("actor-capability-lost");
  if (override.mode === "hold")
    return actor.pos.roomName === override.originRoomName ? null : suspend("route-unavailable");
  const route = [override.originRoomName, ...override.routeRoomNames];
  if (!route.includes(actor.pos.roomName)) return suspend("route-unavailable");
  return null;
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
  if (isCrossRoomExecution(lease.execution) && actor.pos.roomName !== lease.target.roomName) {
    if (crossRoomRouteIndex(lease, actor.pos.roomName) < 0) return suspend("route-unavailable");
    if (!canPerform(actor, lease.execution.action)) return suspend("actor-capability-lost");
    return null;
  }
  if (target === undefined || !samePosition(target.pos, lease.target))
    return suspend("target-missing");
  if (!canPerform(actor, lease.execution.action)) return suspend("actor-capability-lost");
  if (
    lease.execution.version === 4 &&
    (target.type !== "controller" ||
      (target.controllerOwnership !== "neutral" &&
        !(
          target.controllerOwnership === "reserved" &&
          target.controllerReservationUsername === actor.ownerUsername
        )))
  )
    return suspend("controller-blocked");
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
    actor.store.freeCapacity <= 0 &&
    lease.execution.version !== 2 &&
    lease.execution.version !== 5
  )
    return suspend("actor-store-full");
  if (lease.execution.action === "harvest" && target.type !== "source")
    return unavailableTarget(lease, suspend, "target-depleted");
  if (lease.execution.action === "harvest" && target.amount === 0)
    return isStaticMiningExecution(lease.execution)
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
  if (action === "reserve-controller")
    return actor.body.claim.active > 0 && actor.body.move.active > 0;
  if (action === "transfer" || action === "withdraw" || action === "pickup")
    return actor.body.carry.active > 0;
  return actor.body.work.active > 0 && (action === "harvest" || actor.body.carry.active > 0);
}

function needsEnergy(action: LeasedWorkExecution["execution"]["action"]): boolean {
  return action === "build" || action === "repair" || action === "upgrade-controller";
}

function actionIntent(
  lease: LeasedWorkExecution,
  actor: CreepSnapshot,
  target: TargetView,
): CreepActionIntent {
  const signing =
    lease.execution.version === 4 &&
    lease.state === "assigned" &&
    lease.execution.signText !== null;
  return {
    actorId: lease.actorId,
    // A continuous fill lease owns a sink slot, not one energy unit. Omitting the Screeps amount
    // transfers the assigned actor's available cargo without conflating contract quantity with a
    // resource amount.
    amount: actionAmount(lease, actor, target),
    contractId: lease.contractId,
    contractRevision: lease.revision,
    deadline: actionDeadline(lease),
    id: `lease:${lease.contractId}:r${String(lease.revision)}:action`,
    kind: signing ? "sign-controller" : lease.execution.action,
    priority: lease.priority.value,
    resourceType: lease.execution.resourceType,
    targetId: lease.targetId,
    ...(signing ? { text: lease.execution.signText } : {}),
  };
}

function actionAmount(
  lease: LeasedWorkExecution,
  actor: CreepSnapshot,
  target: TargetView,
): number | null {
  if (lease.execution.version !== 3 && lease.execution.version !== 6) {
    return lease.execution.action === "transfer" && lease.execution.completion === "continuous"
      ? null
      : lease.quantity;
  }
  const resource = lease.execution.resourceType;
  const remaining = Math.min(lease.quantity, lease.execution.reservedAmount);
  if (lease.execution.action === "pickup") {
    return Math.min(remaining, target.amount ?? 0, actor.store.freeCapacity ?? remaining);
  }
  if (lease.execution.action === "withdraw") {
    return Math.min(
      remaining,
      target.store === null ? 0 : resourceAmount(target.store, resource),
      actor.store.freeCapacity ?? remaining,
    );
  }
  return Math.min(
    remaining,
    resourceAmount(actor.store, resource),
    target.store?.freeCapacity ?? remaining,
  );
}

function movementIntent(
  lease: LeasedWorkExecution,
  destination: PositionSnapshot,
  direction: DirectionConstant | null,
  goal: PositionSnapshot,
  range: number,
  stuckAge: number,
  roomTransition = false,
  priority = lease.priority.value,
  deadline = actionDeadline(lease),
): MovementIntent {
  return {
    actorId: lease.actorId,
    contractId: lease.contractId,
    contractRevision: lease.revision,
    deadline: Math.min(actionDeadline(lease), deadline),
    destination,
    direction,
    goal,
    id: `lease:${lease.contractId}:r${String(lease.revision)}:move`,
    priority,
    range,
    ...(roomTransition ? { roomTransition: true } : {}),
    stuckAge,
  };
}

function dynamicMovementBlockers(
  snapshot: WorldSnapshot,
  actorId: string,
  proposed: readonly MovementIntent[],
): readonly PositionSnapshot[] | null {
  const actorRoom = snapshot.rooms.find((room) =>
    room.ownedCreeps.some((actor) => actor.id === actorId),
  );
  if (actorRoom === undefined) return null;
  const positions = [
    ...actorRoom.ownedCreeps.filter((actor) => actor.id !== actorId).map((actor) => actor.pos),
    ...actorRoom.hostileCreeps.map((actor) => actor.pos),
    ...proposed
      .filter(
        (intent) => intent.actorId !== actorId && intent.destination.roomName === actorRoom.name,
      )
      .map((intent) => intent.destination),
  ];
  if (positions.length > MAX_DYNAMIC_MOVEMENT_BLOCKERS) return null;
  const byPosition = new Map<string, PositionSnapshot>();
  for (const position of positions)
    byPosition.set(`${position.roomName}:${String(position.x)}:${String(position.y)}`, position);
  const canonical = [...byPosition.values()].sort(
    (left, right) =>
      compareStrings(left.roomName, right.roomName) || left.y - right.y || left.x - right.x,
  );
  return canonical.length <= MAX_DYNAMIC_MOVEMENT_BLOCKERS
    ? Object.freeze(canonical.map((position) => Object.freeze({ ...position })))
    : null;
}

function crossRoomRouteIndex(lease: LeasedWorkExecution, roomName: string): number {
  const route = executionRoute(lease.execution);
  if (route === null) return -1;
  return [route.originRoomName, ...route.routeRoomNames].indexOf(roomName);
}

function crossRoomStep(
  execution: {
    readonly originRoomName: string;
    readonly routeRoomNames: readonly string[];
  },
  origin: PositionSnapshot,
  snapshot: WorldSnapshot,
): {
  readonly destination: PositionSnapshot;
  readonly direction: DirectionConstant;
  readonly exit: PositionSnapshot;
} | null {
  const route = [execution.originRoomName, ...execution.routeRoomNames];
  const index = route.indexOf(origin.roomName);
  const nextRoom = index < 0 ? undefined : route[index + 1];
  if (nextRoom === undefined) return null;
  const direction = roomDirection(origin.roomName, nextRoom);
  const room = snapshot.rooms.find(({ name }) => name === origin.roomName);
  if (direction === null || room?.exits === undefined) return null;
  const exits = room.exits
    .filter((position) => exitMatchesDirection(position, direction))
    .sort(
      (left, right) =>
        Math.max(Math.abs(left.x - origin.x), Math.abs(left.y - origin.y)) -
          Math.max(Math.abs(right.x - origin.x), Math.abs(right.y - origin.y)) ||
        left.y - right.y ||
        left.x - right.x,
    );
  const exit = exits[0];
  if (exit === undefined) return null;
  const destination = crossingDestination(exit, nextRoom, direction);
  return destination === null ? null : { destination, direction, exit };
}

function roomDirection(left: string, right: string): DirectionConstant | null {
  const origin = roomCoordinates(left);
  const destination = roomCoordinates(right);
  if (origin === null || destination === null) return null;
  const x = destination.x - origin.x;
  const y = destination.y - origin.y;
  if (x === 0 && y === -1) return 1;
  if (x === 1 && y === 0) return 3;
  if (x === 0 && y === 1) return 5;
  if (x === -1 && y === 0) return 7;
  return null;
}

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^(W|E)\d+(N|S)\d+$/u.test(value) && value.length <= 16;
}

function roomCoordinates(value: string): { readonly x: number; readonly y: number } | null {
  const match = /^(W|E)(\d+)(N|S)(\d+)$/u.exec(value);
  if (match === null) return null;
  const horizontal = Number(match[2]);
  const vertical = Number(match[4]);
  if (!Number.isSafeInteger(horizontal) || !Number.isSafeInteger(vertical)) return null;
  return {
    x: match[1] === "W" ? -horizontal - 1 : horizontal,
    y: match[3] === "N" ? -vertical - 1 : vertical,
  };
}

function exitMatchesDirection(position: PositionSnapshot, direction: DirectionConstant): boolean {
  return (
    (direction === 1 && position.y === 0) ||
    (direction === 3 && position.x === 49) ||
    (direction === 5 && position.y === 49) ||
    (direction === 7 && position.x === 0)
  );
}

function crossingDestination(
  exit: PositionSnapshot,
  roomName: string,
  direction: DirectionConstant,
): PositionSnapshot | null {
  if (!exitMatchesDirection(exit, direction)) return null;
  if (direction === 1) return { roomName, x: exit.x, y: 49 };
  if (direction === 3) return { roomName, x: 0, y: exit.y };
  if (direction === 5) return { roomName, x: exit.x, y: 0 };
  if (direction === 7) return { roomName, x: 49, y: exit.y };
  return null;
}

function isCrossRoomExecution(execution: ContractExecutionTerms): boolean {
  return executionRoute(execution) !== null;
}
function executionRoute(execution: ContractExecutionTerms): {
  readonly originRoomName: string;
  readonly routeRoomNames: readonly string[];
  readonly routeTravelTicks: number;
} | null {
  if (execution.version === 4 || execution.version === 5)
    return {
      originRoomName: execution.originRoomName,
      routeRoomNames: execution.routeRoomNames,
      routeTravelTicks: execution.routeTravelTicks,
    };
  if (execution.version !== 6) return null;
  return execution.stage === "acquire"
    ? {
        originRoomName: execution.acquireOriginRoomName,
        routeRoomNames: execution.acquireRouteRoomNames,
        routeTravelTicks: execution.acquireRouteTravelTicks,
      }
    : {
        originRoomName: execution.deliverOriginRoomName,
        routeRoomNames: execution.deliverRouteRoomNames,
        routeTravelTicks: execution.deliverRouteTravelTicks,
      };
}

function isStaticMiningExecution(
  execution: ContractExecutionTerms,
): execution is Extract<ContractExecutionTerms, { readonly version: 2 | 5 }> {
  return execution.version === 2 || execution.version === 5;
}

function firstPathDirection(result: LocalPathPlanResult): DirectionConstant | null {
  return result.status === "ready" ? (result.directions[0] ?? null) : null;
}

function afterPathSearch(remaining: number, result: LocalPathPlanResult): number {
  return consumedColdSearch(result)
    ? Math.max(0, remaining - LOCAL_PATH_SEARCH_CPU_ESTIMATE)
    : remaining;
}

function consumedColdSearch(result: LocalPathPlanResult): boolean {
  return (
    (result.status === "ready" && result.source === "search") ||
    (result.status === "no-path" &&
      (result.reason === "adapter-fault" || result.reason === "incomplete"))
  );
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
