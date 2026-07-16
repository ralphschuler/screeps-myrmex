import type { RuntimeConfig } from "../config";
import type { BudgetRequest } from "../colony";
import type {
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { PositionSnapshot, RoomSnapshot, WorldSnapshot } from "../world/snapshot";

export type CriticalMaintenanceReason = "access-road-decay" | "sole-container-loss" | "spawn-loss";

export interface CriticalMaintenanceCandidate {
  readonly budgetRequest: BudgetRequest;
  readonly colonyId: string;
  readonly completionHits: number;
  readonly reason: CriticalMaintenanceReason;
  readonly target: PositionSnapshot;
  readonly targetId: string;
}

export interface CriticalMaintenancePlan {
  readonly candidates: readonly CriticalMaintenanceCandidate[];
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

const MAX_CANDIDATES = 64;
const CONTRACT_EXPIRY = 1_000_000_000;
const ROAD_DECAY_HORIZON = 1_000;

/**
 * Pure Phase 1 selector for only recoverability-critical local repairs. It intentionally has no
 * topology cache: an access road is eligible only when directly adjacent to a spawn, sole
 * container, controller, or source observed in the same room.
 */
export function planCriticalMaintenance(
  snapshot: WorldSnapshot,
  config: RuntimeConfig,
): readonly CriticalMaintenanceCandidate[] {
  const candidates: CriticalMaintenanceCandidate[] = [];
  for (const room of snapshot.rooms) {
    if (room.controller?.ownership !== "owned" || hasActiveThreat(room, config)) continue;
    const roomCandidates = candidatesForRoom(room, config)
      .sort(compareCandidate)
      .slice(0, config.policy.repair.maximumActiveContractsPerRoom);
    candidates.push(...roomCandidates);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return Object.freeze(candidates.slice(0, MAX_CANDIDATES).sort(compareCandidate));
}

/** ColonyDirector remains the sole budget authority; this only renews stable request identities. */
export function renewCriticalMaintenanceBudgets(
  candidates: readonly CriticalMaintenanceCandidate[],
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
): readonly CriticalMaintenanceCandidate[] {
  return Object.freeze(
    candidates.map((candidate) => {
      const prior = existing.find(
        (entry) =>
          entry.category === "critical-maintenance" &&
          entry.colonyId === candidate.colonyId &&
          entry.issuer === candidate.budgetRequest.issuer,
      );
      const reservable = prior?.status === "active" || prior?.status === "pending";
      const due = prior !== undefined && prior.request.expiresAt - tick <= renewalWindowTicks;
      const revision =
        prior === undefined ? 1 : due || !reservable ? prior.revision + 1 : prior.revision;
      const expiresAt =
        prior !== undefined && reservable && !due ? prior.request.expiresAt : tick + durationTicks;
      return {
        ...candidate,
        budgetRequest: { ...candidate.budgetRequest, expiresAt, revision },
      };
    }),
  );
}

export function authorizedCriticalMaintenance(
  candidates: readonly CriticalMaintenanceCandidate[],
  reservations: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly status: string;
  }[],
  planning: ContractPlanningView,
  tick: number,
): CriticalMaintenancePlan {
  const authorized = candidates.filter((candidate) =>
    reservations.some(
      (reservation) =>
        reservation.status === "active" &&
        reservation.category === "critical-maintenance" &&
        reservation.colonyId === candidate.colonyId &&
        reservation.issuer === candidate.budgetRequest.issuer,
    ),
  );
  const issuers = new Set(authorized.map((candidate) => candidate.budgetRequest.issuer));
  const transitions: ContractTransitionRequest[] = [];
  if (planning.status === "ready") {
    for (const contract of planning.contracts) {
      if (!contract.issuer.startsWith("maintenance/") || contract.owner.kind !== "colony") continue;
      if (!issuers.has(contract.issuer)) {
        transitions.push({
          contractId: contract.contractId,
          reason: "maintenance-target-resolved",
          tick,
          to: "cancelled",
        });
      } else if (contract.state === "proposed" || contract.state === "suspended") {
        transitions.push({
          contractId: contract.contractId,
          reason: "maintenance-work-remains",
          tick,
          to: "funded",
        });
      }
    }
  }
  return Object.freeze({
    candidates: Object.freeze(authorized),
    requests: Object.freeze(authorized.map(contractFor).sort(compareRequest)),
    transitions: Object.freeze(
      transitions.sort((left, right) => left.contractId.localeCompare(right.contractId)),
    ),
  });
}

function candidatesForRoom(
  room: RoomSnapshot,
  config: RuntimeConfig,
): CriticalMaintenanceCandidate[] {
  const result: CriticalMaintenanceCandidate[] = [];
  const containers = room.storedStructures.filter(
    (structure) => structure.ownership === "owned" && structure.structureType === "container",
  );
  for (const spawn of room.ownedSpawns) {
    if (isCritical(spawn.hits, spawn.hitsMax, config))
      result.push(candidate(room.name, spawn, "spawn-loss", config));
  }
  if (containers.length === 1) {
    const container = containers[0];
    if (container !== undefined && isCritical(container.hits, container.hitsMax, config)) {
      result.push(candidate(room.name, container, "sole-container-loss", config));
    }
  }
  const accessPoints = [
    ...room.ownedSpawns.map(({ pos }) => pos),
    ...containers.map(({ pos }) => pos),
    ...room.sources.map(({ pos }) => pos),
    ...(room.controller === null ? [] : [room.controller.pos]),
  ];
  for (const road of room.roads ?? []) {
    if (
      (isCritical(road.hits, road.hitsMax, config) ||
        (road.ticksToDecay !== null && road.ticksToDecay <= ROAD_DECAY_HORIZON)) &&
      accessPoints.some((point) => range(road.pos, point) <= 1)
    ) {
      result.push(candidate(room.name, road, "access-road-decay", config));
    }
  }
  return result;
}

function candidate(
  colonyId: string,
  target: {
    readonly hits: number;
    readonly hitsMax: number;
    readonly id: string;
    readonly pos: PositionSnapshot;
  },
  reason: CriticalMaintenanceReason,
  config: RuntimeConfig,
): CriticalMaintenanceCandidate {
  const issuer = `maintenance/${colonyId}/${target.id}`;
  return {
    budgetRequest: {
      colonyId,
      category: "critical-maintenance",
      issuer,
      revision: 1,
      expiresAt: CONTRACT_EXPIRY,
      energy: { minimum: 1, desired: config.policy.repair.maximumEnergyPerTick },
      cpu: { minimum: 1, desired: 1 },
      spawn: null,
    },
    colonyId,
    completionHits: Math.max(
      1,
      Math.floor((target.hitsMax * config.policy.repair.completionHitsBasisPoints) / 10_000),
    ),
    reason,
    target: target.pos,
    targetId: target.id,
  };
}

function contractFor(candidate: CriticalMaintenanceCandidate): WorkContractRequest {
  return {
    budgetBinding: { category: "critical-maintenance", issuer: candidate.budgetRequest.issuer },
    conditions: {
      cancellation: "target-resolved",
      failure: "command-failed",
      success: "threshold",
    },
    deadline: candidate.budgetRequest.expiresAt - 1,
    earliestStart: 0,
    estimatedWorkTicks: 1,
    execution: {
      action: "repair",
      completion: "work-complete",
      completionHits: candidate.completionHits,
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    expiresAt: candidate.budgetRequest.expiresAt,
    issuer: candidate.budgetRequest.issuer,
    issuerKey: candidate.targetId,
    issuerSequence: candidate.budgetRequest.revision,
    kind: "repair",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 1 },
    maxAssignmentCost: 50,
    owner: { id: candidate.colonyId, kind: "colony" },
    preconditionKeys: ["visible-critical-target"],
    priority: { class: "survival", value: priorityFor(candidate.reason) },
    quantity: 1,
    range: 3,
    requiredCapability: {
      attack: 0,
      carry: 1,
      claim: 0,
      heal: 0,
      move: 1,
      rangedAttack: 0,
      tough: 0,
      work: 1,
    },
    target: candidate.target,
    targetId: candidate.targetId,
  };
}

function hasActiveThreat(room: RoomSnapshot, config: RuntimeConfig): boolean {
  return room.hostileCreeps.some(
    (creep) =>
      creep.body.attack.active + creep.body.rangedAttack.active + creep.body.work.active >=
      config.policy.safeMode.minimumHostileOffenseParts,
  );
}

function isCritical(hits: number, hitsMax: number, config: RuntimeConfig): boolean {
  return (
    hitsMax > 0 &&
    Math.floor((hits * 10_000) / hitsMax) <= config.policy.repair.criticalHitsBasisPoints
  );
}

function priorityFor(reason: CriticalMaintenanceReason): number {
  return reason === "spawn-loss" ? 1_900 : reason === "sole-container-loss" ? 1_800 : 1_700;
}
function compareCandidate(
  left: CriticalMaintenanceCandidate,
  right: CriticalMaintenanceCandidate,
): number {
  return (
    priorityFor(right.reason) - priorityFor(left.reason) ||
    left.targetId.localeCompare(right.targetId)
  );
}
function compareRequest(left: WorkContractRequest, right: WorkContractRequest): number {
  return left.issuer.localeCompare(right.issuer);
}
function range(left: PositionSnapshot, right: PositionSnapshot): number {
  return left.roomName === right.roomName
    ? Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y))
    : Infinity;
}
