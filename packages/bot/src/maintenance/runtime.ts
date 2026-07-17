import type { BudgetRequest } from "../colony";
import type {
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { ConstructionPlanningResult, MaintenanceProposal } from "./construction-planner";

const MAINTENANCE_ISSUER_PREFIX = "maintenance-v2/";

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

/** Projects one discretionary room tranche; ColonyDirector remains the sole budget authority. */
export function projectMaintenanceBudgets(input: {
  readonly existing: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly revision: number;
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
      return {
        category: "maintenance",
        colonyId: roomName,
        cpu: { desired: 1, minimum: 0 },
        energy: {
          desired: proposals.reduce((total, { energyCost }) => total + energyCost, 0),
          minimum: 1,
        },
        expiresAt: safeAdd(input.tick, input.ttl),
        issuer,
        revision:
          prior === undefined ? 1 : reservable ? prior.revision : safeAdd(prior.revision, 1),
        spawn: null,
      };
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
  const retirements: ContractTransitionRequest[] = [];
  if (input.contracts.status === "ready") {
    for (const contract of input.contracts.contracts) {
      if (!contract.issuer.startsWith(MAINTENANCE_ISSUER_PREFIX)) continue;
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
    }
  }
  return freeze({
    creepRequests: fundedProposals.map((proposal) => contractFor(proposal, input.budgets)),
    fundedProposals,
    retirements: retirements.sort((a, b) => a.contractId.localeCompare(b.contractId)),
    towerCandidates: fundedProposals.filter(({ towerEligible }) => towerEligible),
  });
}

function contractFor(
  proposal: MaintenanceProposal,
  budgets: readonly BudgetRequest[],
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
    issuerSequence: 1,
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
function safeAdd(value: number, delta: number): number {
  return value <= Number.MAX_SAFE_INTEGER - delta ? value + delta : Number.MAX_SAFE_INTEGER;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
