import {
  MAX_ALLOCATION_ACTORS,
  MAX_ALLOCATION_CONTRACTS,
  MAX_ALLOCATION_PAIRS,
  MAX_SAFE_IDLE_ACTORS,
  capabilitySatisfies,
  capabilitySurplus,
  compareContractPriority,
  compareStrings,
  type WorkforceActor,
  type WorkContractRecord,
} from "./contracts";

export interface TravelEstimateView {
  /** Returns bounded modeled travel ticks, or null when current evidence cannot establish a route. */
  estimate(actor: WorkforceActor, contract: WorkContractRecord): number | null;
}

export type AllocationDeferralReason =
  "contract-capacity" | "expired" | "no-viable-actor" | "not-started" | "not-funded";

export interface ContractAssignmentProposal {
  readonly actorId: string;
  readonly actorName: string;
  readonly assignmentCost: number;
  readonly contractId: string;
  readonly leaseExpiresAt: number;
  readonly travelTicks: number;
}

export interface ContractAllocationDeferral {
  readonly contractId: string;
  readonly reason: AllocationDeferralReason;
}

export interface SafeIdleDisposition {
  readonly actorId: string;
  readonly reason: "no-funded-contract";
}

export interface WorkforceAllocationResult {
  readonly acceptedAssignmentCost: number;
  readonly assignments: readonly ContractAssignmentProposal[];
  readonly deferred: readonly ContractAllocationDeferral[];
  readonly evaluatedPairs: number;
  readonly preservedContractIds: readonly string[];
  readonly safeIdle: readonly SafeIdleDisposition[];
  readonly truncatedActors: number;
  readonly truncatedContracts: number;
}

interface CandidateBid {
  readonly actor: WorkforceActor;
  readonly assignmentCost: number;
  readonly capabilitySurplus: number;
  readonly switchingCost: number;
  readonly travelTicks: number;
  readonly ttlSlack: number;
}

/** Pure bounded policy. It never receives MemoryManager or any live Screeps object. */
export class WorkforceAllocator {
  public allocate(input: {
    readonly actors: readonly WorkforceActor[];
    readonly contracts: readonly WorkContractRecord[];
    readonly tick: number;
    readonly travel: TravelEstimateView;
  }): WorkforceAllocationResult {
    validateTick(input.tick);
    const actors = canonicalActors(input.actors);
    const contracts = [...input.contracts].sort(compareContractPriority);
    const eligible: WorkContractRecord[] = [];
    const deferred: ContractAllocationDeferral[] = [];

    for (const contract of contracts) {
      const ineligibility = contractIneligibility(contract, input.tick);
      if (ineligibility === null) {
        eligible.push(contract);
      } else {
        deferred.push({ contractId: contract.id, reason: ineligibility });
      }
    }

    const consideredContracts = eligible.slice(0, MAX_ALLOCATION_CONTRACTS);
    const consideredActors = selectConsideredActors(actors, consideredContracts);
    const capacityDeferred = eligible.slice(MAX_ALLOCATION_CONTRACTS);
    deferred.push(
      ...capacityDeferred.map((contract) => ({
        contractId: contract.id,
        reason: "contract-capacity" as const,
      })),
    );

    const incumbentByActor = new Map<string, WorkContractRecord>();
    for (const contract of contracts) {
      if (contract.lease !== null && input.tick < contract.lease.expiresAt) {
        incumbentByActor.set(contract.lease.actorId, contract);
      }
    }

    const assignedActors = new Set<string>();
    const assignments: ContractAssignmentProposal[] = [];
    let evaluatedPairs = 0;

    for (const contract of consideredContracts) {
      const bids: CandidateBid[] = [];
      for (const actor of consideredActors) {
        if (assignedActors.has(actor.id)) {
          continue;
        }
        if (evaluatedPairs >= MAX_ALLOCATION_PAIRS) {
          break;
        }
        evaluatedPairs += 1;
        const bid = buildBid(
          actor,
          contract,
          incumbentByActor.get(actor.id),
          input.tick,
          input.travel,
        );
        if (bid !== null) {
          bids.push(bid);
        }
      }

      bids.sort(compareBids);
      const selected = bids[0];
      if (selected === undefined) {
        deferred.push({ contractId: contract.id, reason: "no-viable-actor" });
        continue;
      }
      assignedActors.add(selected.actor.id);
      assignments.push({
        actorId: selected.actor.id,
        actorName: selected.actor.name,
        assignmentCost: selected.assignmentCost,
        contractId: contract.id,
        leaseExpiresAt: Math.min(input.tick + contract.leasePolicy.duration, contract.expiresAt),
        travelTicks: selected.travelTicks,
      });
    }

    const selectedContractIds = new Set(assignments.map((assignment) => assignment.contractId));
    const selectedActorIds = new Set(assignments.map((assignment) => assignment.actorId));
    const preservedContractIds = capacityDeferred
      .filter(
        (contract) => contract.lease !== null && !selectedActorIds.has(contract.lease.actorId),
      )
      .map((contract) => contract.id)
      .sort(compareStrings);
    const preservedActorIds = new Set(
      capacityDeferred.flatMap((contract) =>
        contract.lease !== null && preservedContractIds.includes(contract.id)
          ? [contract.lease.actorId]
          : [],
      ),
    );

    const safeIdle = consideredActors
      .filter((actor) => !selectedActorIds.has(actor.id) && !preservedActorIds.has(actor.id))
      .slice(0, MAX_SAFE_IDLE_ACTORS)
      .map((actor) => ({ actorId: actor.id, reason: "no-funded-contract" as const }));

    assignments.sort((left, right) => compareStrings(left.contractId, right.contractId));
    deferred.sort(
      (left, right) =>
        compareStrings(left.contractId, right.contractId) ||
        compareStrings(left.reason, right.reason),
    );

    if (new Set(assignments.map(({ actorId }) => actorId)).size !== assignments.length) {
      throw new Error("WorkforceAllocator produced more than one primary lease per actor");
    }
    if (new Set(assignments.map(({ contractId }) => contractId)).size !== assignments.length) {
      throw new Error("WorkforceAllocator produced more than one primary lease per contract");
    }
    if (selectedContractIds.size !== assignments.length) {
      throw new Error("WorkforceAllocator produced duplicate contract assignments");
    }

    return deepFreeze({
      acceptedAssignmentCost: assignments.reduce(
        (total, assignment) => total + assignment.assignmentCost,
        0,
      ),
      assignments,
      deferred,
      evaluatedPairs,
      preservedContractIds,
      safeIdle,
      truncatedActors: Math.max(0, actors.length - MAX_ALLOCATION_ACTORS),
      truncatedContracts: Math.max(0, eligible.length - MAX_ALLOCATION_CONTRACTS),
    });
  }
}

export const inRangeOrUnknownTravel: TravelEstimateView = Object.freeze({
  estimate(actor: WorkforceActor, contract: WorkContractRecord): number | null {
    if (actor.pos.roomName !== contract.target.roomName) {
      return null;
    }
    const range = Math.max(
      Math.abs(actor.pos.x - contract.target.x),
      Math.abs(actor.pos.y - contract.target.y),
    );
    return range <= contract.range ? 0 : null;
  },
});

function buildBid(
  actor: WorkforceActor,
  contract: WorkContractRecord,
  incumbent: WorkContractRecord | undefined,
  tick: number,
  travel: TravelEstimateView,
): CandidateBid | null {
  if (
    actor.spawning ||
    actor.ticksToLive === null ||
    !capabilitySatisfies(actor.capability, contract.requiredCapability) ||
    !actionEligible(actor, contract)
  ) {
    return null;
  }
  const travelTicks = travel.estimate(actor, contract);
  if (!Number.isSafeInteger(travelTicks) || (travelTicks ?? -1) < 0) {
    return null;
  }
  const knownTravel = travelTicks as number;
  const modeledWork =
    contract.lease?.actorId === actor.id
      ? remainingModeledTicks(contract, tick, knownTravel)
      : knownTravel + contract.estimatedWorkTicks;
  if (tick + modeledWork > contract.deadline) {
    return null;
  }
  // Allocation happens after Execute, so the current observed TTL cannot supply a new action.
  const ttlSlack = actor.ticksToLive - 1 - modeledWork - contract.leasePolicy.ttlSafetyMargin;
  if (ttlSlack < 0) {
    return null;
  }

  const switchingCost = switchingPenalty(actor.id, incumbent, contract);
  const assignmentCost = knownTravel + switchingCost;
  if (assignmentCost > contract.maxAssignmentCost) {
    return null;
  }

  return {
    actor,
    assignmentCost,
    capabilitySurplus: capabilitySurplus(actor.capability, contract.requiredCapability),
    switchingCost,
    travelTicks: knownTravel,
    ttlSlack,
  };
}

/** Action eligibility is current-tick data only; unknown legacy fixture fields fail neither open nor closed. */
function actionEligible(actor: WorkforceActor, contract: WorkContractRecord): boolean {
  if (contract.execution === undefined) return true;
  if (contract.execution.action === "transfer")
    return actor.energy === undefined || actor.energy > 0;
  if (contract.execution.action === "harvest")
    return (
      (actor.energy === undefined || actor.energy === 0) &&
      (actor.freeCapacity === undefined || actor.freeCapacity === null || actor.freeCapacity > 0)
    );
  return true;
}

function switchingPenalty(
  actorId: string,
  incumbent: WorkContractRecord | undefined,
  next: WorkContractRecord,
): number {
  let penalty = 0;
  if (incumbent !== undefined && incumbent.id !== next.id) {
    penalty += incumbent.leasePolicy.switchingPenalty;
  }
  if (next.lease !== null && next.lease.actorId !== actorId) {
    penalty += next.leasePolicy.switchingPenalty;
  }
  return penalty;
}

export function remainingModeledTicks(
  contract: WorkContractRecord,
  tick: number,
  currentTravelTicks: number,
): number {
  const lease = contract.lease;
  if (lease === null) {
    return currentTravelTicks + contract.estimatedWorkTicks;
  }
  const elapsed = Math.max(0, tick - lease.assignedAt);
  const scheduledTravelRemaining = Math.max(0, lease.travelTicks - elapsed);
  // The world snapshot was captured in Observe, but lease validation runs after this tick's
  // Execute. Align current route evidence with the post-Execute schedule by applying one modeled
  // travel opportunity before deciding that the actor has fallen behind.
  const observedTravelAfterCurrentOpportunity = Math.max(0, currentTravelTicks - 1);
  const remainingTravel = Math.max(scheduledTravelRemaining, observedTravelAfterCurrentOpportunity);
  const scheduleDelay = remainingTravel - scheduledTravelRemaining;
  const modeledWorkOpportunities = Math.max(0, elapsed - lease.travelTicks - scheduleDelay);
  const remainingWork = Math.max(0, contract.estimatedWorkTicks - modeledWorkOpportunities);
  return remainingTravel + remainingWork;
}

function compareBids(left: CandidateBid, right: CandidateBid): number {
  return (
    left.switchingCost - right.switchingCost ||
    left.travelTicks - right.travelTicks ||
    left.capabilitySurplus - right.capabilitySurplus ||
    left.ttlSlack - right.ttlSlack ||
    compareStrings(left.actor.id, right.actor.id)
  );
}

function contractIneligibility(
  contract: WorkContractRecord,
  tick: number,
): AllocationDeferralReason | null {
  if (tick < contract.earliestStart) {
    return "not-started";
  }
  if (tick >= contract.expiresAt || tick > contract.deadline) {
    return "expired";
  }
  if (contract.state !== "funded" && contract.state !== "assigned" && contract.state !== "active") {
    return "not-funded";
  }
  return null;
}

function canonicalActors(actors: readonly WorkforceActor[]): WorkforceActor[] {
  const sorted = [...actors].sort((left, right) => compareStrings(left.id, right.id));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.id === sorted[index]?.id) {
      throw new Error(`Duplicate workforce actor id: ${sorted[index]?.id ?? "unknown"}`);
    }
  }
  return sorted;
}

function selectConsideredActors(
  actors: readonly WorkforceActor[],
  contracts: readonly WorkContractRecord[],
): WorkforceActor[] {
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const selected: WorkforceActor[] = [];
  const selectedIds = new Set<string>();

  // A bounded allocator must not churn valid incumbent leases merely because an actor sorts after
  // the general actor cap. Contract priority determines which incumbents receive that reservation.
  for (const contract of contracts) {
    const actor = contract.lease === null ? undefined : actorById.get(contract.lease.actorId);
    if (actor !== undefined && !selectedIds.has(actor.id)) {
      selected.push(actor);
      selectedIds.add(actor.id);
      if (selected.length >= MAX_ALLOCATION_ACTORS) {
        return selected;
      }
    }
  }

  for (const actor of actors) {
    if (!selectedIds.has(actor.id)) {
      selected.push(actor);
      selectedIds.add(actor.id);
      if (selected.length >= MAX_ALLOCATION_ACTORS) {
        break;
      }
    }
  }
  return selected;
}

function validateTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError("Workforce allocation tick must be a non-negative safe integer");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
