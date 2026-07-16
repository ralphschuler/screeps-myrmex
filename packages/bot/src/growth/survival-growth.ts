import type { RuntimeConfig } from "../config";
import type { BudgetRequest } from "../colony";
import type {
  ContractPlanningView,
  ContractTransitionRequest,
  WorkContractRequest,
} from "../contracts";
import type { PositionSnapshot, WorldSnapshot } from "../world/snapshot";

export type GrowthAction = "build" | "upgrade-controller";
export interface GrowthCandidate {
  readonly action: GrowthAction;
  readonly budgetRequest: BudgetRequest;
  readonly colonyId: string;
  readonly order: number;
  readonly reasonCode: "controller-risk" | "optional-growth" | "rcl1-bootstrap-controller";
  readonly target: PositionSnapshot;
  readonly targetId: string;
}
export interface GrowthPlan {
  readonly candidates: readonly GrowthCandidate[];
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

const EXPIRY = 1_000_000_000;
const MAX_GROWTH_CANDIDATES = 64;

/**
 * Produces only post-survival growth work. Controller risk is explicitly ranked above optional
 * construction; every existing owned site is ranked deterministically without placing new sites or
 * claiming Phase 2 layout ownership.
 */
export function planSurvivalGrowth(
  snapshot: WorldSnapshot,
  config: RuntimeConfig,
): readonly GrowthCandidate[] {
  const candidates: GrowthCandidate[] = [];
  for (const room of snapshot.rooms) {
    const controller = room.controller;
    if (controller?.ownership !== "owned" || room.hostileCreeps.length > 0) continue;
    const urgency =
      controller.ticksToDowngrade !== null &&
      controller.ticksToDowngrade <= config.policy.recovery.controllerRiskWindowTicks;
    if (urgency) {
      candidates.push(
        upgradeCandidate(room.name, controller.id, controller.pos, "controller-risk", config),
      );
    }
    if (qualifiesRcl1Bootstrap(room, config)) {
      candidates.push(bootstrapCandidate(room.name, controller.id, controller.pos, config));
      continue;
    }
    if (
      room.energyAvailable <
      config.policy.recovery.protectedSpawnEnergy + config.policy.growth.minimumSurplusEnergy
    )
      continue;
    const sites = room.constructionSites
      .filter(({ ownership }) => ownership === "owned")
      .slice()
      .sort(
        (left, right) =>
          siteRank(left.structureType) - siteRank(right.structureType) ||
          left.id.localeCompare(right.id),
      );
    for (const site of sites.slice(0, config.policy.growth.maximumActiveContractsPerRoom)) {
      candidates.push(
        buildCandidate(room.name, site.id, site.pos, siteRank(site.structureType), config),
      );
    }
    if (!urgency && sites.length === 0) {
      candidates.push(
        upgradeCandidate(room.name, controller.id, controller.pos, "optional-growth", config),
      );
    }
    if (candidates.length >= MAX_GROWTH_CANDIDATES) break;
  }
  return Object.freeze(candidates.slice(0, MAX_GROWTH_CANDIDATES).sort(compareCandidate));
}

export function renewGrowthBudgets(
  candidates: readonly GrowthCandidate[],
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
): readonly GrowthCandidate[] {
  return Object.freeze(
    candidates.map((candidate) => {
      const prior = existing.find(
        (entry) =>
          entry.category === candidate.budgetRequest.category &&
          entry.colonyId === candidate.colonyId &&
          entry.issuer === candidate.budgetRequest.issuer,
      );
      const reservable = prior?.status === "active" || prior?.status === "pending";
      const due = prior !== undefined && prior.request.expiresAt - tick <= renewalWindowTicks;
      const revision =
        prior === undefined ? 1 : due || !reservable ? prior.revision + 1 : prior.revision;
      const expiresAt =
        prior !== undefined && reservable && !due ? prior.request.expiresAt : tick + durationTicks;
      return { ...candidate, budgetRequest: { ...candidate.budgetRequest, expiresAt, revision } };
    }),
  );
}

export function authorizedSurvivalGrowth(
  candidates: readonly GrowthCandidate[],
  reservations: readonly {
    readonly category: string;
    readonly colonyId: string;
    readonly issuer: string;
    readonly status: string;
  }[],
  planning: ContractPlanningView,
  tick: number,
  snapshot?: WorldSnapshot,
): GrowthPlan {
  const roomByName =
    snapshot === undefined
      ? null
      : new Map(snapshot.rooms.map((room) => [room.name, room] as const));
  const authorized = candidates.filter((candidate) =>
    reservations.some(
      (reservation) =>
        reservation.status === "active" &&
        reservation.category === candidate.budgetRequest.category &&
        reservation.colonyId === candidate.colonyId &&
        reservation.issuer === candidate.budgetRequest.issuer,
    ),
  );
  const issuers = new Set(authorized.map((candidate) => candidate.budgetRequest.issuer));
  const transitions: ContractTransitionRequest[] = [];
  if (planning.status === "ready")
    for (const contract of planning.contracts) {
      if (!contract.issuer.startsWith("growth/") || contract.owner.kind !== "colony") continue;
      if (
        !issuers.has(contract.issuer) &&
        contract.budgetBinding.category !== "bootstrap-controller"
      )
        transitions.push({
          contractId: contract.contractId,
          reason: "growth-target-resolved",
          tick,
          to: "cancelled",
        });
      else if (
        contract.budgetBinding.category === "bootstrap-controller" &&
        !reusabilityConfirmedForBootstrap(contract, roomByName)
      ) {
        transitions.push({
          contractId: contract.contractId,
          reason: "growth-target-resolved",
          tick,
          to: "cancelled",
        });
      } else if (contract.state === "proposed" || contract.state === "suspended")
        transitions.push({
          contractId: contract.contractId,
          reason: "growth-work-remains",
          tick,
          to: "funded",
        });
    }
  return Object.freeze({
    candidates: Object.freeze(authorized),
    requests: Object.freeze(
      authorized.map(contractFor).sort((a, b) => a.issuer.localeCompare(b.issuer)),
    ),
    transitions: Object.freeze(
      transitions.sort((a, b) => a.contractId.localeCompare(b.contractId)),
    ),
  });
}

function upgradeCandidate(
  colonyId: string,
  targetId: string,
  target: PositionSnapshot,
  category: "bootstrap-controller" | "controller-risk" | "optional-growth",
  config: RuntimeConfig,
): GrowthCandidate {
  return candidate(colonyId, "upgrade-controller", targetId, target, category, 0, config);
}
function buildCandidate(
  colonyId: string,
  targetId: string,
  target: PositionSnapshot,
  order: number,
  config: RuntimeConfig,
): GrowthCandidate {
  return candidate(colonyId, "build", targetId, target, "optional-growth", order, config);
}
function bootstrapCandidate(
  colonyId: string,
  targetId: string,
  target: PositionSnapshot,
  config: RuntimeConfig,
): GrowthCandidate {
  return candidate(
    colonyId,
    "upgrade-controller",
    targetId,
    target,
    "bootstrap-controller",
    0,
    config,
  );
}
function candidate(
  colonyId: string,
  action: GrowthAction,
  targetId: string,
  target: PositionSnapshot,
  category: "bootstrap-controller" | "controller-risk" | "optional-growth",
  order: number,
  config: RuntimeConfig,
): GrowthCandidate {
  const issuer = `growth/${colonyId}/${action}/${targetId}`;
  return {
    action,
    colonyId,
    order,
    reasonCode: category === "bootstrap-controller" ? "rcl1-bootstrap-controller" : category,
    target,
    targetId,
    budgetRequest: {
      colonyId,
      category,
      issuer,
      revision: 1,
      expiresAt: EXPIRY,
      // Controller work spends creep cargo, not room energy. This leaves the full recovery
      // reserve untouched while a newly harvested batch bridges RCL1 to RCL2.
      energy:
        category === "bootstrap-controller"
          ? null
          : { minimum: 1, desired: config.policy.growth.maximumEnergyPerTick },
      cpu: { minimum: 1, desired: 1 },
      spawn: null,
    },
  };
}
function contractFor(candidate: GrowthCandidate): WorkContractRequest {
  const controller = candidate.action === "upgrade-controller";
  return {
    budgetBinding: {
      category: candidate.budgetRequest.category,
      issuer: candidate.budgetRequest.issuer,
    },
    conditions: {
      cancellation: "target-resolved",
      failure: "command-failed",
      success: controller ? "continuous" : "work-complete",
    },
    deadline: candidate.budgetRequest.expiresAt - 1,
    earliestStart: 0,
    estimatedWorkTicks: 1,
    execution: {
      action: candidate.action,
      completion: controller ? "continuous" : "work-complete",
      completionHits: null,
      counterpartId: null,
      resourceType: null,
      version: 1,
    },
    expiresAt: candidate.budgetRequest.expiresAt,
    issuer: candidate.budgetRequest.issuer,
    issuerKey: candidate.targetId,
    issuerSequence: candidate.budgetRequest.revision,
    kind: controller ? "upgrade" : "build",
    leasePolicy: { duration: 10, switchingPenalty: 1, ttlSafetyMargin: 1 },
    maxAssignmentCost: 50,
    owner: { id: candidate.colonyId, kind: "colony" },
    preconditionKeys: ["visible-growth-target"],
    priority: {
      class: "growth",
      value:
        candidate.budgetRequest.category === "controller-risk"
          ? 1_600
          : candidate.budgetRequest.category === "bootstrap-controller"
            ? 1_200
            : 500,
    },
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
function siteRank(type: string): number {
  const rank = [
    "spawn",
    "extension",
    "container",
    "tower",
    "storage",
    "terminal",
    "link",
    "lab",
    "factory",
    "observer",
    "powerSpawn",
    "nuker",
    "extractor",
    "rampart",
    "constructedWall",
    "road",
  ].indexOf(type);
  return rank < 0 ? 1_000 : rank;
}
function compareCandidate(left: GrowthCandidate, right: GrowthCandidate): number {
  const category = (value: GrowthCandidate) =>
    value.budgetRequest.category === "controller-risk"
      ? 0
      : value.budgetRequest.category === "bootstrap-controller"
        ? 1
        : 2;
  return (
    category(left) - category(right) ||
    (left.action === "build" ? 0 : 1) - (right.action === "build" ? 0 : 1) ||
    left.order - right.order ||
    left.targetId.localeCompare(right.targetId)
  );
}

function qualifiesRcl1Bootstrap(
  room: WorldSnapshot["rooms"][number],
  config: RuntimeConfig,
): boolean {
  const controller = room.controller;
  if (
    controller?.ownership !== "owned" ||
    controller.level !== 1 ||
    room.energyAvailable !== room.energyCapacityAvailable ||
    room.energyAvailable < config.policy.recovery.protectedSpawnEnergy ||
    room.ownedExtensions.length !== 0 ||
    room.ownedSpawns.filter(({ active }) => active).length !== 1
  )
    return false;
  const replacementLeadTicks = 3 * 3 + config.policy.spawn.replacementSafetyMarginTicks;
  return room.ownedCreeps.some(
    (creep) =>
      !creep.spawning &&
      creep.body.work.active >= 1 &&
      creep.body.carry.active >= 1 &&
      creep.body.move.active >= 1 &&
      (creep.ticksToLive === null || creep.ticksToLive > replacementLeadTicks) &&
      creep.store.resources.some(
        ({ resourceType, amount }) => resourceType === "energy" && amount > 0,
      ),
  );
}

function reusabilityConfirmedForBootstrap(
  contract: {
    readonly owner: {
      readonly id: string;
    };
  },
  roomsByName: ReadonlyMap<string, WorldSnapshot["rooms"][number]> | null,
): boolean {
  if (roomsByName === null) {
    return true;
  }
  const room = roomsByName.get(contract.owner.id);
  if (room === undefined) {
    return true;
  }
  const controller = room.controller;
  return (
    controller?.ownership === "owned" &&
    controller.level === 1 &&
    room.ownedExtensions.length === 0 &&
    room.ownedSpawns.filter(({ active }) => active).length === 1
  );
}
