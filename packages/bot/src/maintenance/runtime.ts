import type { BudgetRequest } from "../colony";
import {
  nextIssuerSequence,
  type ContractPlanningRecord,
  type ContractPlanningView,
  type ContractTransitionRequest,
  type WorkContractRequest,
} from "../contracts";
import type { ConstructionPlanningResult, MaintenanceProposal } from "./construction-planner";
import type { WorldSnapshot } from "../world/snapshot";

const MAINTENANCE_ISSUER_PREFIX = "maintenance-v2/";
const MAXIMUM_TRAFFIC_OBSERVATIONS = 128;

export interface MaintenanceBudgetProjection {
  readonly budgets: readonly BudgetRequest[];
  readonly planning: ConstructionPlanningResult;
}

export interface AuthorizedMaintenanceProjection {
  readonly creepRequests: readonly WorkContractRequest[];
  readonly fundedProposals: readonly MaintenanceProposal[];
  readonly retirements: readonly ContractTransitionRequest[];
  readonly towerCandidates: readonly MaintenanceProposal[];
}

export interface MaintenanceExecutionAssignment {
  readonly creepRequests: readonly WorkContractRequest[];
  readonly duplicateTargetsSuppressed: number;
}

/** Current-tick, bounded traffic evidence. Layout membership remains a separate planner input. */
export function measureMaintenanceTraffic(snapshot: WorldSnapshot): readonly {
  readonly score: number;
  readonly targetId: string;
}[] {
  const scores = new Map<string, number>();
  for (const room of [...snapshot.rooms].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const creeps = [...room.ownedCreeps].sort((left, right) => left.id.localeCompare(right.id));
    const structures = [...(room.roads ?? []), ...room.storedStructures, ...(room.structures ?? [])]
      .filter((structure, index, all) => all.findIndex(({ id }) => id === structure.id) === index)
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const structure of structures) {
      let score = 0;
      for (const creep of creeps) {
        const range = Math.max(
          Math.abs(creep.pos.x - structure.pos.x),
          Math.abs(creep.pos.y - structure.pos.y),
        );
        if (range <= 3) score += range === 0 ? 4 : range === 1 ? 2 : 1;
      }
      if (score > 0) scores.set(structure.id, score);
    }
  }
  return freeze(
    [...scores]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAXIMUM_TRAFFIC_OBSERVATIONS)
      .map(([targetId, score]) => ({ score, targetId })),
  );
}

/** Assigns each target to exactly one executor, retaining creep fallback when no tower was planned. */
export function assignMaintenanceExecution(
  authorized: AuthorizedMaintenanceProjection,
  towerTargets: readonly { readonly target: string }[],
): MaintenanceExecutionAssignment {
  const assignedToTower = new Set(towerTargets.map(({ target }) => target));
  const selectedByBinding = new Map<string, WorkContractRequest>();
  const candidates = authorized.creepRequests
    .filter(({ targetId }) => targetId === null || !assignedToTower.has(targetId))
    .sort(compareCreepRequests);
  for (const request of candidates) {
    const key = `${request.owner.kind}\u0000${request.owner.id}\u0000${request.budgetBinding.category}\u0000${request.budgetBinding.issuer}`;
    if (!selectedByBinding.has(key)) selectedByBinding.set(key, request);
  }
  const creepRequests = [...selectedByBinding.values()].sort(compareCreepRequests);
  return freeze({
    creepRequests,
    duplicateTargetsSuppressed: authorized.creepRequests.length - creepRequests.length,
  });
}

/** Classifies only observable terminal target state; ambiguous replans emit no outcome. */
export function maintenanceWorkOutcomes(
  contracts: ContractPlanningView,
  snapshot: WorldSnapshot,
  retirements: readonly ContractTransitionRequest[],
): readonly ("overshoot" | "retired" | "satisfied")[] {
  if (contracts.status !== "ready") return freeze([]);
  const retiring = new Set(
    retirements
      .filter(({ reason }) => reason === "maintenance-band-resolved")
      .map(({ contractId }) => contractId),
  );
  const structures = snapshot.rooms.flatMap((room) => [
    ...(room.roads ?? []),
    ...room.storedStructures,
    ...(room.structures ?? []),
  ]);
  const outcomes: ("overshoot" | "retired" | "satisfied")[] = [];
  for (const contract of contracts.contracts) {
    if (
      !retiring.has(contract.contractId) ||
      !contract.issuer.startsWith(MAINTENANCE_ISSUER_PREFIX)
    )
      continue;
    const target = structures.find(({ id }) => id === contract.targetId);
    if (target === undefined) outcomes.push("retired");
    else if (contract.execution.version === 1) {
      const completionHits = contract.execution.completionHits;
      if (typeof completionHits !== "number") continue;
      if (target.hits > completionHits) outcomes.push("overshoot");
      else if (target.hits === completionHits) outcomes.push("satisfied");
    }
  }
  return freeze(outcomes.sort());
}

/** Projects one discretionary room tranche; ColonyDirector remains the sole budget authority. */
export function projectMaintenanceBudgets(input: {
  readonly existing: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
    readonly request: BudgetRequest;
    readonly status: string;
  }[];
  readonly planning: ConstructionPlanningResult;
  readonly tick: number;
  readonly ttl: number;
}): MaintenanceBudgetProjection {
  const byRoom = new Map<string, MaintenanceProposal[]>();
  for (const proposal of input.planning.proposals) {
    const room = byRoom.get(proposal.roomName) ?? [];
    room.push(proposal);
    byRoom.set(proposal.roomName, room);
  }
  const budgets = [...byRoom]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roomName, proposals]): BudgetRequest => {
      const issuer = roomBudgetIssuer(roomName);
      const prior = input.existing.find(
        ({ category, colonyId, issuer: existingIssuer }) =>
          category === "maintenance" && colonyId === roomName && existingIssuer === issuer,
      );
      const reservable = prior?.status === "active" || prior?.status === "pending";
      const desired: BudgetRequest = {
        category: "maintenance",
        colonyId: roomName,
        cpu: { desired: 1, minimum: 0 },
        energy: {
          desired: proposals.reduce((total, { energyCost }) => total + energyCost, 0),
          minimum: 1,
        },
        expiresAt: safeAdd(input.tick, input.ttl),
        issuer,
        revision: prior === undefined ? 1 : safeAdd(prior.revision, 1),
        spawn: null,
      };
      const renewalDue =
        prior !== undefined && prior.request.expiresAt - input.tick <= Math.min(1, input.ttl);
      return prior !== undefined &&
        reservable &&
        !renewalDue &&
        sameBudgetClaims(prior.request, desired)
        ? cloneBudgetRequest(prior.request)
        : desired;
    });
  return freeze({ budgets, planning: input.planning });
}

/** Converts only actively funded policy output into target-specific work and retirement transitions. */
export function authorizeMaintenanceWork(input: {
  readonly budgets: readonly BudgetRequest[];
  readonly planning: ConstructionPlanningResult;
  readonly reservations: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly status: string;
  }[];
  readonly contracts: ContractPlanningView;
  readonly tick: number;
}): AuthorizedMaintenanceProjection {
  if (input.contracts.status !== "ready") {
    return freeze({
      creepRequests: [],
      fundedProposals: [],
      retirements: [],
      towerCandidates: [],
    });
  }
  const fundedRooms = new Set(
    input.budgets.flatMap((budget) =>
      input.reservations.some(
        ({ category, colonyId, issuer, status }) =>
          status === "active" &&
          category === budget.category &&
          colonyId === budget.colonyId &&
          issuer === budget.issuer,
      )
        ? [budget.colonyId]
        : [],
    ),
  );
  const fundedProposals = input.planning.proposals.filter(({ roomName }) =>
    fundedRooms.has(roomName),
  );
  const currentIssuers = new Set(fundedProposals.map(contractIssuer));
  const activeByIssuer = new Map<string, ContractPlanningRecord>();
  const occupiedBindings = new Set<string>();
  const retirements: ContractTransitionRequest[] = [];
  for (const contract of input.contracts.contracts) {
    if (!contract.issuer.startsWith(MAINTENANCE_ISSUER_PREFIX)) continue;
    activeByIssuer.set(contract.issuer, contract);
    if (!currentIssuers.has(contract.issuer))
      retirements.push({
        contractId: contract.contractId,
        reason: "maintenance-band-resolved",
        tick: input.tick,
        to: "cancelled",
      });
    else if (contract.state === "proposed" || contract.state === "suspended")
      retirements.push({
        contractId: contract.contractId,
        reason: "maintenance-funded",
        tick: input.tick,
        to: "funded",
      });
    if (currentIssuers.has(contract.issuer)) {
      occupiedBindings.add(
        `${contract.owner.kind}\u0000${contract.owner.id}\u0000${contract.budgetBinding.category}\u0000${contract.budgetBinding.issuer}`,
      );
    }
  }
  return freeze({
    creepRequests: fundedProposals.flatMap((proposal) => {
      const issuer = contractIssuer(proposal);
      if (activeByIssuer.has(issuer)) return [];
      const binding = input.budgets.find(({ colonyId }) => colonyId === proposal.roomName);
      if (
        binding === undefined ||
        occupiedBindings.has(
          `colony\u0000${proposal.roomName}\u0000maintenance\u0000${binding.issuer}`,
        )
      )
        return [];
      const sequence = nextIssuerSequence(input.contracts, issuer);
      return sequence === null ? [] : [contractFor(proposal, input.budgets, sequence)];
    }),
    fundedProposals,
    retirements: retirements.sort((a, b) => a.contractId.localeCompare(b.contractId)),
    towerCandidates: fundedProposals.filter(({ towerEligible }) => towerEligible),
  });
}

function contractFor(
  proposal: MaintenanceProposal,
  budgets: readonly BudgetRequest[],
  issuerSequence: number,
): WorkContractRequest {
  const budget = budgets.find(({ colonyId }) => colonyId === proposal.roomName);
  if (budget === undefined) throw new Error("funded maintenance proposal lost its room budget");
  return {
    budgetBinding: { category: "maintenance", issuer: budget.issuer },
    conditions: {
      cancellation: "target-resolved",
      failure: "command-failed",
      success: "threshold",
    },
    deadline: budget.expiresAt - 1,
    earliestStart: 0,
    estimatedWorkTicks: Math.max(1, proposal.energyCost),
    execution: {
      action: "repair",
      completion: "work-complete",
      completionHits: proposal.targetHits,
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    expiresAt: budget.expiresAt,
    issuer: contractIssuer(proposal),
    issuerKey: proposal.targetId,
    issuerSequence,
    kind: "repair",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 1 },
    maxAssignmentCost: 100,
    owner: { id: proposal.roomName, kind: "colony" },
    preconditionKeys: ["visible-maintenance-target", `target-hits/${String(proposal.targetHits)}`],
    priority: { class: "maintenance", value: proposal.priority },
    quantity: proposal.energyCost,
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
    target: proposal.targetPos,
    targetId: proposal.targetId,
  };
}

function roomBudgetIssuer(roomName: string): string {
  return `${MAINTENANCE_ISSUER_PREFIX}${roomName}`;
}
function contractIssuer(proposal: MaintenanceProposal): string {
  return `${MAINTENANCE_ISSUER_PREFIX}${proposal.roomName}/${proposal.targetId}/${String(proposal.targetHits)}`;
}
function compareCreepRequests(left: WorkContractRequest, right: WorkContractRequest): number {
  return (
    right.priority.value - left.priority.value ||
    (left.targetId ?? "").localeCompare(right.targetId ?? "") ||
    left.issuer.localeCompare(right.issuer)
  );
}
function safeAdd(value: number, delta: number): number {
  return value <= Number.MAX_SAFE_INTEGER - delta ? value + delta : Number.MAX_SAFE_INTEGER;
}
function sameBudgetClaims(left: BudgetRequest, right: BudgetRequest): boolean {
  return (
    left.category === right.category &&
    left.colonyId === right.colonyId &&
    left.issuer === right.issuer &&
    left.energy?.minimum === right.energy?.minimum &&
    left.energy?.desired === right.energy?.desired &&
    left.cpu?.minimum === right.cpu?.minimum &&
    left.cpu?.desired === right.cpu?.desired &&
    left.spawn === null &&
    right.spawn === null
  );
}
function cloneBudgetRequest(request: BudgetRequest): BudgetRequest {
  return {
    ...request,
    cpu: request.cpu === null ? null : { ...request.cpu },
    energy: request.energy === null ? null : { ...request.energy },
    spawn: request.spawn === null ? null : { ...request.spawn },
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
