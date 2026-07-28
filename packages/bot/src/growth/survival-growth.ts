import type { RuntimeConfig } from "../config";
import type { BudgetRequest } from "../colony";
import {
  contractIdFor,
  type ContractPlanningView,
  type ContractReplacementRequest,
  type ContractTransitionRequest,
  type WorkContractRequest,
} from "../contracts";
import type { PositionSnapshot, WorldSnapshot } from "../world/snapshot";

export type GrowthAction = "build" | "upgrade-controller";
export interface GrowthCandidate {
  readonly action: GrowthAction;
  readonly budgetRequest: BudgetRequest;
  readonly colonyId: string;
  readonly order: number;
  readonly reasonCode:
    | "controller-risk"
    | "optional-growth"
    | "rcl1-bootstrap-controller"
    | "rcl2-infrastructure-bootstrap";
  readonly target: PositionSnapshot;
  readonly targetId: string;
}
export interface GrowthPlan {
  readonly candidates: readonly GrowthCandidate[];
  readonly replacements: readonly ContractReplacementRequest[];
  readonly requests: readonly WorkContractRequest[];
  readonly transitions: readonly ContractTransitionRequest[];
}

const EXPIRY = 1_000_000_000;
const MAX_GROWTH_CANDIDATES = 64;
const BOOTSTRAP_MAX_ASSIGNMENT_COST = 1_500;
const GROWTH_MAX_ASSIGNMENT_COST = 50;

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
    const sites = room.constructionSites
      .filter(({ ownership }) => ownership === "owned")
      .slice()
      .sort(
        (left, right) =>
          siteRank(left.structureType) - siteRank(right.structureType) ||
          left.id.localeCompare(right.id),
      );
    if (qualifiesRcl2InfrastructureBootstrap(room, config)) {
      for (const site of sites
        .filter(({ structureType }) => structureType === "extension")
        .slice(0, config.policy.growth.maximumActiveContractsPerRoom)) {
        candidates.push(rcl2InfrastructureBootstrapCandidate(room.name, site.id, site.pos, config));
      }
      continue;
    }
    if (
      room.energyAvailable <
      config.policy.recovery.protectedSpawnEnergy + config.policy.growth.minimumSurplusEnergy
    )
      continue;
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
      // Any fresh RCL1 bootstrap worker that passes the 1,500-tick assignment and TTL gates must
      // also fit the contract deadline. Generic 50-tick leases remain unchanged for other work.
      const horizon =
        candidate.budgetRequest.category === "bootstrap-controller"
          ? Math.max(durationTicks, BOOTSTRAP_MAX_ASSIGNMENT_COST)
          : durationTicks;
      const expiresAt =
        prior !== undefined && reservable && !due ? prior.request.expiresAt : tick + horizon;
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
  config?: RuntimeConfig,
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
  const existingIssuers = new Set(
    planning.status === "ready" ? planning.contracts.map(({ issuer }) => issuer) : [],
  );
  const replacements: ContractReplacementRequest[] = [];
  const replacingPredecessors = new Set<string>();
  const transitions: ContractTransitionRequest[] = [];
  if (planning.status === "ready") {
    for (const candidate of authorized) {
      if (candidate.budgetRequest.category !== "bootstrap-controller") continue;
      const matches = planning.contracts.filter(
        ({ issuer }) => issuer === candidate.budgetRequest.issuer,
      );
      const predecessor = matches.length === 1 ? matches[0] : undefined;
      if (
        predecessor === undefined ||
        predecessor.issuerSequence === undefined ||
        candidate.budgetRequest.revision !== predecessor.issuerSequence + 1
      )
        continue;
      const successor = contractFor(candidate);
      const successorId = contractIdFor(
        successor.issuer,
        successor.issuerKey,
        successor.issuerSequence,
      );
      replacements.push({
        predecessorContractId: predecessor.contractId,
        reason: "growth-budget-renewed",
        successor,
        tick,
      });
      replacingPredecessors.add(predecessor.contractId);
      transitions.push({
        contractId: successorId,
        reason: "growth-work-remains",
        tick,
        to: "funded",
      });
    }

    for (const contract of planning.contracts) {
      if (replacingPredecessors.has(contract.contractId)) continue;
      if (!contract.issuer.startsWith("growth/") || contract.owner.kind !== "colony") continue;
      if (isRcl2InfrastructureBootstrap(contract.issuer)) {
        const reusable = reusabilityConfirmedForRcl2InfrastructureBootstrap(
          contract,
          roomByName,
          config ?? null,
        );
        if (!issuers.has(contract.issuer) && !reusable)
          transitions.push({
            contractId: contract.contractId,
            reason: "growth-target-resolved",
            tick,
            to: "cancelled",
          });
        else if (
          issuers.has(contract.issuer) &&
          (contract.state === "proposed" || contract.state === "suspended")
        )
          transitions.push({
            contractId: contract.contractId,
            reason: "growth-work-remains",
            tick,
            to: "funded",
          });
        continue;
      }
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
  }
  return Object.freeze({
    candidates: Object.freeze(authorized),
    replacements: Object.freeze(
      replacements.sort((a, b) => a.predecessorContractId.localeCompare(b.predecessorContractId)),
    ),
    requests: Object.freeze(
      authorized
        .filter(
          ({ budgetRequest }) =>
            (!isRcl2InfrastructureBootstrap(budgetRequest.issuer) ||
              !existingIssuers.has(budgetRequest.issuer)) &&
            (budgetRequest.category !== "bootstrap-controller" ||
              !existingIssuers.has(budgetRequest.issuer)),
        )
        .map(contractFor)
        .sort((a, b) => a.issuer.localeCompare(b.issuer)),
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
function rcl2InfrastructureBootstrapCandidate(
  colonyId: string,
  targetId: string,
  target: PositionSnapshot,
  config: RuntimeConfig,
): GrowthCandidate {
  return candidate(colonyId, "build", targetId, target, "optional-growth", 0, config, {
    issuer: `growth/${colonyId}/rcl2-bootstrap/build/${targetId}`,
    reasonCode: "rcl2-infrastructure-bootstrap",
  });
}
function candidate(
  colonyId: string,
  action: GrowthAction,
  targetId: string,
  target: PositionSnapshot,
  category: "bootstrap-controller" | "controller-risk" | "optional-growth",
  order: number,
  config: RuntimeConfig,
  overrides: {
    readonly issuer?: string;
    readonly reasonCode?: GrowthCandidate["reasonCode"];
  } = {},
): GrowthCandidate {
  const issuer = overrides.issuer ?? `growth/${colonyId}/${action}/${targetId}`;
  return {
    action,
    colonyId,
    order,
    reasonCode:
      overrides.reasonCode ??
      (category === "bootstrap-controller" ? "rcl1-bootstrap-controller" : category),
    target,
    targetId,
    budgetRequest: {
      colonyId,
      category,
      issuer,
      revision: 1,
      expiresAt: EXPIRY,
      // Bootstrap work spends creep cargo, not room energy. This leaves the full recovery
      // reserve untouched while carried energy bridges RCL1 or builds initial RCL2 capacity.
      energy:
        category === "bootstrap-controller" ||
        overrides.reasonCode === "rcl2-infrastructure-bootstrap"
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
    maxAssignmentCost:
      candidate.budgetRequest.category === "bootstrap-controller" ||
      candidate.reasonCode === "rcl2-infrastructure-bootstrap"
        ? BOOTSTRAP_MAX_ASSIGNMENT_COST
        : GROWTH_MAX_ASSIGNMENT_COST,
    owner: { id: candidate.colonyId, kind: "colony" },
    preconditionKeys: ["visible-growth-target"],
    priority: {
      class: "growth",
      value:
        candidate.budgetRequest.category === "controller-risk"
          ? 1_600
          : candidate.budgetRequest.category === "bootstrap-controller" ||
              candidate.reasonCode === "rcl2-infrastructure-bootstrap"
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

function qualifiesRcl2InfrastructureBootstrap(
  room: WorldSnapshot["rooms"][number],
  config: RuntimeConfig,
): boolean {
  const controller = room.controller;
  const normalGrowthFloor =
    config.policy.recovery.protectedSpawnEnergy + config.policy.growth.minimumSurplusEnergy;
  if (
    controller?.ownership !== "owned" ||
    controller.level !== 2 ||
    room.energyCapacityAvailable >= normalGrowthFloor ||
    room.energyAvailable < config.policy.recovery.protectedSpawnEnergy ||
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

function isRcl2InfrastructureBootstrap(issuer: string): boolean {
  return issuer.includes("/rcl2-bootstrap/build/");
}

function reusabilityConfirmedForRcl2InfrastructureBootstrap(
  contract: {
    readonly owner: { readonly id: string };
    readonly targetId: string;
  },
  roomsByName: ReadonlyMap<string, WorldSnapshot["rooms"][number]> | null,
  config: RuntimeConfig | null,
): boolean {
  if (roomsByName === null || config === null) return true;
  const room = roomsByName.get(contract.owner.id);
  if (room === undefined) return true;
  const normalGrowthFloor =
    config.policy.recovery.protectedSpawnEnergy + config.policy.growth.minimumSurplusEnergy;
  return (
    room.controller?.ownership === "owned" &&
    room.controller.level === 2 &&
    room.energyCapacityAvailable < normalGrowthFloor &&
    room.ownedSpawns.filter(({ active }) => active).length === 1 &&
    room.constructionSites.some(
      ({ id, ownership, structureType }) =>
        id === contract.targetId && ownership === "owned" && structureType === "extension",
    )
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
