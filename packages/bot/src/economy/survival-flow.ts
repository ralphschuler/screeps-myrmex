import type { BudgetRequest } from "../colony";
import type {
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { PositionSnapshot, RoomSnapshot, WorldSnapshot } from "../world/snapshot";

export interface SurvivalFlowCandidate {
  readonly action: "harvest" | "transfer";
  readonly actorId: string;
  readonly budgetRequest: BudgetRequest;
  readonly colonyId: string;
  readonly targetId: string;
  readonly target: PositionSnapshot;
}

export interface SurvivalFlowPlan {
  readonly candidates: readonly SurvivalFlowCandidate[];
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

const MAX_SURVIVAL_FLOW_CANDIDATES = 64;
const SURVIVAL_FLOW_EXPIRY = 1_000_000_000;

/**
 * Selects visible, local source and sink work.  It emits stable demand identities only: Colony
 * and Contract ledgers remain the respective budget and work authorities.
 */
export function planSurvivalFlow(snapshot: WorldSnapshot): readonly SurvivalFlowCandidate[] {
  const candidates: SurvivalFlowCandidate[] = [];
  for (const room of snapshot.rooms.filter((value) => value.controller?.ownership === "owned")) {
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
      const action = carriedEnergy > 0 ? "transfer" : "harvest";
      const target =
        action === "harvest"
          ? source(room, actor.pos, reservedSources)
          : sink(room, actor.pos, reservedSinks);
      if (target !== null) {
        (action === "harvest" ? reservedSources : reservedSinks).add(target.id);
        candidates.push(candidate(room.name, actor.id, action, target));
      }
    }
  }
  return Object.freeze(
    candidates.sort((left, right) =>
      compareStrings(left.budgetRequest.issuer, right.budgetRequest.issuer),
    ),
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
  const replacementActions = new Set(
    authorized.map(({ action, actorId, colonyId }) => `${colonyId}/${actorId}/${action}`),
  );
  const requests = authorized
    .map(contractFor)
    .sort((left, right) => compareStrings(left.issuer, right.issuer));
  const transitions: ContractTransitionRequest[] = [];
  if (planning.status === "ready") {
    for (const contract of planning.contracts) {
      if (!contract.issuer.startsWith("economy/") || contract.owner.kind !== "colony") continue;
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
        !currentIssuers.has(contract.issuer) &&
        replacementActions.has(contractActionKey(contract.issuer))
      ) {
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

function candidate(
  colonyId: string,
  actorId: string,
  action: "harvest" | "transfer",
  target: { readonly id: string; readonly pos: PositionSnapshot },
): SurvivalFlowCandidate {
  const issuer = `economy/${colonyId}/${actorId}/${action}/${target.id}`;
  return {
    action,
    actorId,
    colonyId,
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
  return {
    budgetBinding: { category: "harvesting-filling", issuer: candidate.budgetRequest.issuer },
    conditions: {
      cancellation: "target-replaced",
      failure: "command-failed",
      success: "continuous",
    },
    deadline: SURVIVAL_FLOW_EXPIRY - 1,
    earliestStart: 0,
    estimatedWorkTicks: 1,
    execution: {
      action: candidate.action,
      completion: "continuous",
      counterpartId: null,
      resourceType: harvest ? null : "energy",
      version: 1,
    },
    expiresAt: SURVIVAL_FLOW_EXPIRY,
    issuer: candidate.budgetRequest.issuer,
    issuerKey: `${candidate.action}:${candidate.targetId}`,
    issuerSequence: 1,
    kind: harvest ? "harvest" : "fill",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 1 },
    maxAssignmentCost: 50,
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

function source(
  room: RoomSnapshot,
  from: PositionSnapshot,
  reserved: ReadonlySet<string>,
): { readonly id: string; readonly pos: PositionSnapshot } | null {
  return (
    room.sources
      .filter((value) => value.energy > 0 && !reserved.has(value.id))
      .slice()
      .sort(
        (left, right) =>
          distance(from, left.pos) - distance(from, right.pos) || compareStrings(left.id, right.id),
      )[0] ?? null
  );
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
function contractActionKey(issuer: string): string {
  const parts = issuer.split("/");
  const [, colonyId, actorId, action] = parts;
  return parts.length === 5 &&
    colonyId !== undefined &&
    actorId !== undefined &&
    action !== undefined
    ? `${colonyId}/${actorId}/${action}`
    : "";
}
function sink(
  room: RoomSnapshot,
  from: PositionSnapshot,
  reserved: ReadonlySet<string>,
): { readonly id: string; readonly pos: PositionSnapshot } | null {
  return (
    [...room.ownedSpawns, ...room.ownedExtensions]
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
