import type { BudgetRequest } from "../colony";
import {
  contractEnergyExecutionPhase,
  MAX_LEASE_EXECUTION_ACTORS,
  nextIssuerSequence,
  type ContractExecutionView,
  type ContractPlanningView,
  type ContractTransitionRequest,
  type WorkContractRequest,
} from "../contracts";
import type { PositionSnapshot, RoomSnapshot, WorldSnapshot } from "../world/snapshot";

export interface SurvivalFlowCandidate {
  readonly action: "harvest" | "pickup" | "transfer";
  readonly actorId: string;
  readonly budgetRequest: BudgetRequest;
  readonly colonyId: string;
  readonly contractSequence: number;
  readonly targetId: string;
  readonly target: PositionSnapshot;
}

export interface SurvivalFlowPlan {
  readonly candidates: readonly SurvivalFlowCandidate[];
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

const MAX_SURVIVAL_FLOW_CANDIDATES = 64;
const SURVIVAL_FLOW_MAX_ASSIGNMENT_COST = 1_500;
const SURVIVAL_FLOW_EXPIRY = 1_000_000_000;

/**
 * Selects visible, local source and sink work.  It emits stable demand identities only: Colony
 * and Contract ledgers remain the respective budget and work authorities.
 */
export function planSurvivalFlow(
  snapshot: WorldSnapshot,
  execution: ContractExecutionView = { leases: [], status: "unavailable" },
  planning: ContractPlanningView = { contracts: [], status: "unavailable" },
): readonly SurvivalFlowCandidate[] {
  const candidates: SurvivalFlowCandidate[] = [];
  const activeActionByActor = activeSurvivalActionByActor(execution, planning);
  const activeEnergyConsumers = activeEnergyConsumersByActor(execution);
  const staticBindings = staticMiningBindings(planning);
  const staticTakeovers = staticSourceTakeovers(execution, planning, snapshot);
  for (const room of snapshot.rooms.filter((value) => value.controller?.ownership === "owned")) {
    const roomBindings = staticBindings.get(room.name) ?? new Map();
    const roomTakeovers = staticTakeovers.get(room.name) ?? new Map();
    const reservedDrops = new Set<string>();
    const reservedSources = new Set<string>();
    const reservedSinks = new Set<string>();
    for (const actor of room.ownedCreeps.slice().sort(compareById)) {
      if (
        candidates.length >= MAX_SURVIVAL_FLOW_CANDIDATES ||
        actor.spawning ||
        actor.ticksToLive === null
      )
        continue;
      const carriedEnergy = resourceAmount(actor, "energy");
      const canHarvest =
        actor.store.freeCapacity === null ? carriedEnergy === 0 : actor.store.freeCapacity > 0;
      const canAcquire = canHarvest && !(carriedEnergy > 0 && activeEnergyConsumers.has(actor.id));
      const pickupTarget = canAcquire
        ? staticMiningDrop(room, actor.pos, reservedDrops, roomBindings)
        : null;
      const harvestTarget = canAcquire
        ? source(room, actor.pos, reservedSources, new Set(roomTakeovers.keys()))
        : null;
      const transferTarget = carriedEnergy > 0 ? sink(room, actor.pos, reservedSinks) : null;
      const activeAction = activeActionByActor.get(actor.id);
      const action =
        activeAction === "transfer" && transferTarget !== null
          ? "transfer"
          : activeAction === "pickup" && pickupTarget !== null
            ? "pickup"
            : activeAction === "harvest" && harvestTarget !== null
              ? "harvest"
              : pickupTarget !== null && transferTarget !== null
                ? "transfer"
                : pickupTarget !== null
                  ? "pickup"
                  : harvestTarget !== null
                    ? "harvest"
                    : "transfer";
      const target =
        action === "harvest" ? harvestTarget : action === "pickup" ? pickupTarget : transferTarget;
      if (target !== null) {
        const contractSequence = survivalContractSequence(planning, room.name, action, target.id);
        if (contractSequence === null) continue;
        (action === "harvest"
          ? reservedSources
          : action === "pickup"
            ? reservedDrops
            : reservedSinks
        ).add(target.id);
        candidates.push(candidate(room.name, actor.id, action, target, contractSequence));
      }
    }
  }
  return Object.freeze(
    candidates.sort((left, right) =>
      compareStrings(left.budgetRequest.issuer, right.budgetRequest.issuer),
    ),
  );
}

function activeEnergyConsumersByActor(execution: ContractExecutionView): ReadonlySet<string> {
  if (execution.status !== "ready") return new Set();
  return new Set(
    execution.leases
      .filter(({ execution: terms }) => contractEnergyExecutionPhase(terms.action) === "consume")
      .map(({ actorId }) => actorId),
  );
}

export function withoutSupersededSurvivalHarvestLeases(
  execution: ContractExecutionView,
  planning: ContractPlanningView,
  snapshot: WorldSnapshot,
): ContractExecutionView {
  const takeovers = staticSourceTakeovers(execution, planning, snapshot);
  const suppressedContractIds = supersededSurvivalHarvestContractIds(planning, takeovers);
  if (suppressedContractIds.size === 0) return execution;
  return Object.freeze({
    leases: Object.freeze(
      execution.leases.filter(({ contractId }) => !suppressedContractIds.has(contractId)),
    ),
    status: execution.status,
  });
}

function activeSurvivalActionByActor(
  execution: ContractExecutionView,
  planning: ContractPlanningView,
): ReadonlyMap<string, "harvest" | "pickup" | "transfer"> {
  if (execution.status !== "ready" || planning.status !== "ready") return new Map();
  const economyContractIds = new Set(
    planning.contracts.filter(isSurvivalFlowContract).map(({ contractId }) => contractId),
  );
  const actions = new Map<string, "harvest" | "pickup" | "transfer">();
  for (const lease of execution.leases) {
    if (!economyContractIds.has(lease.contractId)) continue;
    if (
      lease.execution.action === "harvest" ||
      lease.execution.action === "pickup" ||
      lease.execution.action === "transfer"
    ) {
      actions.set(lease.actorId, lease.execution.action);
    }
  }
  return actions;
}

function isSurvivalFlowContract(contract: ContractPlanningView["contracts"][number]): boolean {
  const [scope, colonyId, action, targetId, ...extra] = contract.issuer.split("/");
  const executionMatches =
    (action === "harvest" &&
      contract.execution.action === "harvest" &&
      contract.execution.resourceType === null) ||
    (action === "transfer" &&
      contract.execution.action === "transfer" &&
      contract.execution.resourceType === "energy") ||
    (action === "pickup" &&
      contract.execution.action === "pickup" &&
      contract.execution.resourceType === null);
  return (
    scope === "economy" &&
    extra.length === 0 &&
    colonyId !== undefined &&
    colonyId.length > 0 &&
    targetId !== undefined &&
    targetId.length > 0 &&
    contract.owner.kind === "colony" &&
    contract.owner.id === colonyId &&
    contract.budgetBinding.category === "harvesting-filling" &&
    contract.budgetBinding.issuer === contract.issuer &&
    executionMatches
  );
}

/** Renewal is calculated by ColonyDirector from its owned ledger view, never by the planner. */
export function renewSurvivalFlowBudgets(
  candidates: readonly SurvivalFlowCandidate[],
  existing: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly request: BudgetRequest;
    readonly status: string;
  }[],
  tick: number,
  durationTicks: number,
  renewalWindowTicks: number,
): readonly SurvivalFlowCandidate[] {
  return Object.freeze(
    candidates.map((candidate) => {
      const prior = existing.find(
        (entry) =>
          entry.colonyId === candidate.colonyId &&
          entry.category === "harvesting-filling" &&
          entry.issuer === candidate.budgetRequest.issuer,
      );
      const reservable = prior?.status === "active" || prior?.status === "pending";
      const renewalDue =
        prior !== undefined && prior.request.expiresAt - tick <= renewalWindowTicks;
      const revision =
        prior === undefined ? 1 : renewalDue || !reservable ? prior.revision + 1 : prior.revision;
      const expiresAt =
        prior !== undefined && !renewalDue && reservable
          ? prior.request.expiresAt
          : tick + durationTicks;
      return { ...candidate, budgetRequest: { ...candidate.budgetRequest, expiresAt, revision } };
    }),
  );
}

export function authorizedSurvivalFlow(
  candidates: readonly SurvivalFlowCandidate[],
  reservations: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly status: string;
  }[],
  planning: ContractPlanningView,
  tick: number,
  observation: WorldSnapshot | null = null,
  execution: ContractExecutionView = { leases: [], status: "unavailable" },
): SurvivalFlowPlan {
  const authorized = candidates.filter((candidate) =>
    reservations.some(
      (reservation) =>
        reservation.status === "active" &&
        reservation.category === "harvesting-filling" &&
        reservation.colonyId === candidate.colonyId &&
        reservation.issuer === candidate.budgetRequest.issuer,
    ),
  );
  const currentIssuers = new Set(authorized.map((candidate) => candidate.budgetRequest.issuer));
  const staticTakeovers: ReadonlyMap<
    string,
    ReadonlyMap<string, PositionSnapshot>
  > = observation === null
    ? new Map<string, ReadonlyMap<string, PositionSnapshot>>()
    : staticSourceTakeovers(execution, planning, observation);
  const requests = authorized
    .map(contractFor)
    .sort((left, right) => compareStrings(left.issuer, right.issuer));
  const transitions: ContractTransitionRequest[] = [];
  if (planning.status === "ready") {
    for (const contract of planning.contracts) {
      if (!isSurvivalFlowContract(contract)) continue;
      if (
        currentIssuers.has(contract.issuer) &&
        (contract.state === "proposed" || contract.state === "suspended")
      ) {
        transitions.push({
          contractId: contract.contractId,
          reason: "survival-work-remains",
          tick,
          to: "funded",
        });
      } else if (
        contract.execution.action === "harvest" &&
        contract.state !== "proposed" &&
        contract.state !== "suspended" &&
        staticTakeovers.get(contract.owner.id)?.has(contract.targetId)
      ) {
        transitions.push({
          contractId: contract.contractId,
          reason: "static-miner-ready",
          tick,
          to: "suspended",
        });
      } else if (
        !currentIssuers.has(contract.issuer) &&
        observation !== null &&
        survivalEndpointRetired(contract, observation)
      ) {
        // A confirmed visible endpoint disappearance retires the demand. A temporary lack of
        // workers only suspends it: its endpoint identity must remain reusable by replacement
        // workers without attempting to recreate a terminal contract.
        transitions.push({
          contractId: contract.contractId,
          reason: "survival-target-replaced",
          tick,
          to: "cancelled",
        });
      }
    }
  }
  return Object.freeze({
    candidates: Object.freeze(authorized),
    requests: Object.freeze(requests),
    transitions: Object.freeze(
      transitions.sort((left, right) => compareStrings(left.contractId, right.contractId)),
    ),
  });
}

function survivalEndpointRetired(
  contract: ContractPlanningView["contracts"][number],
  snapshot: WorldSnapshot,
): boolean {
  const room = snapshot.rooms.find(({ name }) => name === contract.owner.id);
  if (room === undefined) return false;
  return contract.execution.action === "harvest"
    ? !room.sources.some(({ id }) => id === contract.targetId)
    : contract.execution.action === "pickup"
      ? !(room.droppedResources ?? []).some(({ id }) => id === contract.targetId)
      : ![...room.ownedSpawns, ...room.ownedExtensions].some(({ id }) => id === contract.targetId);
}

function candidate(
  colonyId: string,
  actorId: string,
  action: "harvest" | "pickup" | "transfer",
  target: { readonly id: string; readonly pos: PositionSnapshot },
  contractSequence: number,
): SurvivalFlowCandidate {
  const issuer = `economy/${colonyId}/${action}/${target.id}`;
  return {
    action,
    actorId,
    colonyId,
    contractSequence,
    targetId: target.id,
    target: target.pos,
    budgetRequest: {
      colonyId,
      category: "harvesting-filling",
      issuer,
      revision: 1,
      expiresAt: SURVIVAL_FLOW_EXPIRY,
      energy: null,
      cpu: { minimum: 1, desired: 1 },
      spawn: null,
    },
  };
}

function contractFor(candidate: SurvivalFlowCandidate): WorkContractRequest {
  const harvest = candidate.action === "harvest";
  const pickup = candidate.action === "pickup";
  return {
    budgetBinding: { category: "harvesting-filling", issuer: candidate.budgetRequest.issuer },
    conditions: {
      cancellation: "target-replaced",
      failure: "command-failed",
      success: pickup ? "target-depleted" : "continuous",
    },
    deadline: SURVIVAL_FLOW_EXPIRY - 1,
    earliestStart: 0,
    estimatedWorkTicks: 1,
    execution: {
      action: candidate.action,
      completion: pickup ? "target-depleted" : "continuous",
      counterpartId: null,
      resourceType: harvest || pickup ? null : "energy",
      version: 1,
    },
    expiresAt: SURVIVAL_FLOW_EXPIRY,
    issuer: candidate.budgetRequest.issuer,
    issuerKey: `${candidate.action}:${candidate.targetId}`,
    issuerSequence: candidate.contractSequence,
    kind: harvest ? "harvest" : pickup ? "haul" : "fill",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 1 },
    // TTL/deadline checks remain authoritative; this cap must not reject a viable local-room route
    // merely because the fatigue-safe travel model intentionally overestimates arrival time.
    maxAssignmentCost: SURVIVAL_FLOW_MAX_ASSIGNMENT_COST,
    owner: { id: candidate.colonyId, kind: "colony" },
    preconditionKeys: ["visible-target"],
    priority: { class: "survival", value: 1_000 },
    quantity: 1,
    range: 1,
    requiredCapability: {
      attack: 0,
      carry: 1,
      claim: 0,
      heal: 0,
      move: 1,
      rangedAttack: 0,
      tough: 0,
      work: harvest ? 1 : 0,
    },
    target: candidate.target,
    targetId: candidate.targetId,
  };
}

function staticMiningDrop(
  room: RoomSnapshot,
  from: PositionSnapshot,
  reserved: ReadonlySet<string>,
  bindings: ReadonlyMap<string, PositionSnapshot>,
): { readonly id: string; readonly pos: PositionSnapshot } | null {
  const workPositions = [...bindings.values()];
  return (
    (room.droppedResources ?? [])
      .filter(
        (value) =>
          value.amount > 0 &&
          value.resourceType === "energy" &&
          !reserved.has(value.id) &&
          workPositions.some((position) => distance(position, value.pos) <= 1),
      )
      .slice(0, MAX_SURVIVAL_FLOW_CANDIDATES)
      .sort(
        (left, right) =>
          distance(from, left.pos) - distance(from, right.pos) || compareStrings(left.id, right.id),
      )[0] ?? null
  );
}

function source(
  room: RoomSnapshot,
  from: PositionSnapshot,
  reserved: ReadonlySet<string>,
  staticallyBound: ReadonlySet<string>,
): { readonly id: string; readonly pos: PositionSnapshot } | null {
  return (
    room.sources
      .filter(
        (value) => value.energy > 0 && !reserved.has(value.id) && !staticallyBound.has(value.id),
      )
      .slice()
      .sort(
        (left, right) =>
          distance(from, left.pos) - distance(from, right.pos) || compareStrings(left.id, right.id),
      )[0] ?? null
  );
}
function survivalContractSequence(
  planning: ContractPlanningView,
  colonyId: string,
  action: SurvivalFlowCandidate["action"],
  targetId: string,
): number | null {
  const issuer = `economy/${colonyId}/${action}/${targetId}`;
  return nextIssuerSequence(planning, issuer);
}

function staticSourceTakeovers(
  execution: ContractExecutionView,
  planning: ContractPlanningView,
  snapshot: WorldSnapshot,
): ReadonlyMap<string, ReadonlyMap<string, PositionSnapshot>> {
  if (execution.status !== "ready" || planning.status !== "ready") return new Map();
  let current = execution;
  let takeovers = staticSourceTakeoversOnce(current, planning, snapshot);
  for (let pass = 0; pass <= execution.leases.length; pass += 1) {
    const suppressed = supersededSurvivalHarvestContractIds(planning, takeovers);
    const leases = current.leases.filter(({ contractId }) => !suppressed.has(contractId));
    if (leases.length === current.leases.length) return takeovers;
    current = Object.freeze({ leases: Object.freeze(leases), status: "ready" });
    takeovers = staticSourceTakeoversOnce(current, planning, snapshot);
  }
  return takeovers;
}

function staticSourceTakeoversOnce(
  execution: ContractExecutionView,
  planning: ContractPlanningView,
  snapshot: WorldSnapshot,
): ReadonlyMap<string, ReadonlyMap<string, PositionSnapshot>> {
  const result = new Map<string, Map<string, PositionSnapshot>>();
  const admittedActorIds = admittedLeaseActorIds(execution);
  for (const contract of planning.contracts) {
    const identity = staticMiningIdentity(contract);
    if (identity === null || (contract.state !== "assigned" && contract.state !== "active"))
      continue;
    const lease = execution.leases.find(({ contractId }) => contractId === contract.contractId);
    const room = snapshot.rooms.find(({ name }) => name === identity.colonyId);
    const actor = room?.ownedCreeps.find(({ id }) => id === lease?.actorId);
    const source = room?.sources.find(({ id }) => id === identity.sourceId);
    if (
      lease === undefined ||
      !admittedActorIds.has(lease.actorId) ||
      lease.state !== contract.state ||
      lease.targetId !== identity.sourceId ||
      lease.execution.version !== 2 ||
      lease.execution.workPosition.roomName !== identity.workPosition.roomName ||
      lease.execution.workPosition.x !== identity.workPosition.x ||
      lease.execution.workPosition.y !== identity.workPosition.y ||
      snapshot.observedAt >
        Math.min(lease.deadline, lease.expiresAt - 1, lease.leaseExpiresAt - 1) ||
      actor === undefined ||
      actor.name !== lease.actorName ||
      actor.spawning ||
      actor.ticksToLive === null ||
      actor.ticksToLive <= 1 ||
      actor.body.work.active < 1 ||
      actor.pos.roomName !== identity.workPosition.roomName ||
      actor.pos.x !== identity.workPosition.x ||
      actor.pos.y !== identity.workPosition.y ||
      source === undefined ||
      distance(identity.workPosition, source.pos) > 1 ||
      source.pos.roomName !== lease.target.roomName ||
      source.pos.x !== lease.target.x ||
      source.pos.y !== lease.target.y
    )
      continue;
    const bindings = result.get(identity.colonyId) ?? new Map<string, PositionSnapshot>();
    bindings.set(identity.sourceId, identity.workPosition);
    result.set(identity.colonyId, bindings);
  }
  return result;
}

function supersededSurvivalHarvestContractIds(
  planning: ContractPlanningView,
  takeovers: ReadonlyMap<string, ReadonlyMap<string, PositionSnapshot>>,
): ReadonlySet<string> {
  return new Set(
    planning.contracts.flatMap((contract) =>
      isSurvivalFlowContract(contract) &&
      contract.execution.action === "harvest" &&
      takeovers.get(contract.owner.id)?.has(contract.targetId)
        ? [contract.contractId]
        : [],
    ),
  );
}

function admittedLeaseActorIds(execution: ContractExecutionView): ReadonlySet<string> {
  const actorIds = new Set<string>();
  for (const lease of [...execution.leases].sort(
    (left, right) =>
      compareStrings(left.actorId, right.actorId) ||
      compareStrings(left.contractId, right.contractId),
  )) {
    if (actorIds.size >= MAX_LEASE_EXECUTION_ACTORS) break;
    actorIds.add(lease.actorId);
  }
  return actorIds;
}

function staticMiningBindings(
  planning: ContractPlanningView,
): ReadonlyMap<string, ReadonlyMap<string, PositionSnapshot>> {
  const result = new Map<string, Map<string, PositionSnapshot>>();
  if (planning.status !== "ready") return result;
  for (const contract of planning.contracts) {
    const identity = staticMiningIdentity(contract);
    if (identity === null) continue;
    const bindings = result.get(identity.colonyId) ?? new Map<string, PositionSnapshot>();
    bindings.set(identity.sourceId, identity.workPosition);
    result.set(identity.colonyId, bindings);
  }
  return result;
}

function staticMiningIdentity(
  contract: ContractPlanningView["contracts"][number],
  includeSuspended = false,
): {
  readonly colonyId: string;
  readonly sourceId: string;
  readonly workPosition: PositionSnapshot;
} | null {
  const [scope, colonyId, sourceId, ...extra] = contract.issuer.split("/");
  const stateMatches = includeSuspended
    ? ["funded", "assigned", "active", "suspended"].includes(contract.state)
    : ["funded", "assigned", "active"].includes(contract.state);
  if (
    scope !== "mining" ||
    colonyId === undefined ||
    sourceId === undefined ||
    extra.length !== 0 ||
    !stateMatches ||
    contract.owner.kind !== "colony" ||
    contract.owner.id !== colonyId ||
    contract.targetId !== sourceId ||
    contract.budgetBinding.category !== "harvesting-filling" ||
    contract.budgetBinding.issuer !== contract.issuer ||
    contract.execution.version !== 2
  )
    return null;
  return { colonyId, sourceId, workPosition: contract.execution.workPosition };
}
function resourceAmount(
  actor: {
    readonly store: {
      readonly resources: readonly { readonly amount: number; readonly resourceType: string }[];
    };
  },
  resourceType: string,
): number {
  return (
    actor.store.resources.find((resource) => resource.resourceType === resourceType)?.amount ?? 0
  );
}
function sink(
  room: RoomSnapshot,
  from: PositionSnapshot,
  reserved: ReadonlySet<string>,
): { readonly id: string; readonly pos: PositionSnapshot } | null {
  return (
    [
      ...room.ownedSpawns.filter(({ active }) => active),
      ...room.ownedExtensions.filter(({ active }) => active),
    ]
      .filter(
        (value) =>
          value.store.freeCapacity !== null &&
          value.store.freeCapacity > 0 &&
          !reserved.has(value.id),
      )
      .slice()
      .sort(
        (left, right) =>
          distance(from, left.pos) - distance(from, right.pos) || compareStrings(left.id, right.id),
      )[0] ?? null
  );
}
function distance(left: PositionSnapshot, right: PositionSnapshot): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareStrings(left.id, right.id);
}
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
