import type { RuntimeConfig } from "../config";
import type { BudgetRequest } from "../colony";
import {
  type CapabilityVector,
  contractIdFor,
  RCL1_CONTROLLER_FUNDING_HANDOFF,
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
  readonly requiredCapability: CapabilityVector;
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
const RCL2_PROGRESSION_CAPACITY = 550;
const RCL2_CONTROLLER_UPGRADE_SLOTS = 13;
const RCL2_CONTROLLER_LANE_PRIORITY = 1_100;
const RCL2_CONTROLLER_LEASE_DURATION = 50;

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
    const rcl1BootstrapPhase = qualifiesRcl1BootstrapPhase(room, config);
    const rcl1Bootstrap = rcl1BootstrapPhase && hasViableEnergizedWorker(room, config);
    if (urgency) {
      candidates.push(
        upgradeCandidate(
          room.name,
          controller.id,
          controller.pos,
          "controller-risk",
          config,
          controller.level === 1,
        ),
      );
    }
    if (!urgency && rcl1Bootstrap) {
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
    if (qualifiesRcl2InfrastructureBootstrap(room)) {
      for (const [index, site] of sites
        .filter(({ structureType }) => structureType === "extension")
        .slice(0, config.policy.growth.maximumActiveContractsPerRoom)
        .entries()) {
        candidates.push(
          rcl2InfrastructureBootstrapCandidate(
            room.name,
            site.id,
            site.pos,
            config,
            index === 0 && room.energyCapacityAvailable >= 400
              ? capability(2, 1, 2)
              : capability(1, 1, 1),
          ),
        );
      }
      continue;
    }
    const rcl2ProgressionReady =
      !urgency &&
      controller.level === 2 &&
      room.energyCapacityAvailable >= RCL2_PROGRESSION_CAPACITY;
    if (
      room.energyAvailable <
      config.policy.recovery.protectedSpawnEnergy + config.policy.growth.minimumSurplusEnergy
    ) {
      // Controller work consumes creep cargo, not the room pool. Once the complete RCL2 spawn pool
      // exists, keep its stable workload funded while spawning or filling temporarily drains that
      // pool. Dropping these candidates here used to discard the consume lease mid-cargo.
      if (rcl2ProgressionReady)
        candidates.push(
          ...rcl2ControllerUpgradeCandidates(room.name, controller.id, controller.pos, config),
        );
      continue;
    }
    // Once the complete RCL2 spawn pool exists, construction may continue but cannot occupy every
    // discretionary growth lane. The frozen progression row needs one lane of headroom for stable
    // controller work while layout roads and later structures remain backlogged.
    const buildLimit = rcl2ProgressionReady
      ? Math.max(0, config.policy.growth.maximumActiveContractsPerRoom - 1)
      : config.policy.growth.maximumActiveContractsPerRoom;
    for (const site of sites.slice(0, buildLimit)) {
      candidates.push(
        buildCandidate(room.name, site.id, site.pos, siteRank(site.structureType), config),
      );
    }
    if (rcl2ProgressionReady) {
      candidates.push(
        ...rcl2ControllerUpgradeCandidates(room.name, controller.id, controller.pos, config),
      );
    } else if (!urgency && (sites.length === 0 || controller.level === 2)) {
      candidates.push(
        upgradeCandidate(
          room.name,
          controller.id,
          controller.pos,
          "optional-growth",
          config,
          controller.level === 2,
        ),
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
      const prior = existing
        .filter(
          (entry) =>
            entry.colonyId === candidate.colonyId &&
            entry.issuer === candidate.budgetRequest.issuer &&
            (entry.category === candidate.budgetRequest.category ||
              isRcl1ControllerCategoryHandoff(entry.category, candidate.budgetRequest.category)),
        )
        .sort(
          (left, right) =>
            right.revision - left.revision || left.category.localeCompare(right.category),
        )[0];
      const reservable = prior?.status === "active" || prior?.status === "pending";
      const categoryChanged =
        prior !== undefined && prior.category !== candidate.budgetRequest.category;
      const claimChanged =
        prior !== undefined &&
        !sameEnergyClaim(prior.request.energy, candidate.budgetRequest.energy);
      const persistentRcl2Controller =
        candidate.action === "upgrade-controller" &&
        candidate.budgetRequest.category === "optional-growth" &&
        candidate.budgetRequest.energy === null;
      const due =
        !persistentRcl2Controller &&
        prior !== undefined &&
        prior.request.expiresAt - tick <= renewalWindowTicks;
      const revision =
        prior === undefined
          ? 1
          : categoryChanged || claimChanged || due || !reservable
            ? prior.revision + 1
            : prior.revision;
      // Any fresh RCL1 bootstrap worker that passes the 1,500-tick assignment and TTL gates must
      // also fit the contract deadline. Generic 50-tick leases remain unchanged for other work.
      const horizon =
        candidate.budgetRequest.category === "bootstrap-controller"
          ? Math.max(durationTicks, BOOTSTRAP_MAX_ASSIGNMENT_COST)
          : persistentRcl2Controller
            ? EXPIRY - tick
            : durationTicks;
      const expiresAt =
        prior !== undefined && reservable && !categoryChanged && !claimChanged && !due
          ? prior.request.expiresAt
          : tick + horizon;
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
  const plannedIssuers = new Set(candidates.map((candidate) => candidate.budgetRequest.issuer));
  const authorizedIssuers = new Set(authorized.map((candidate) => candidate.budgetRequest.issuer));
  const existingIssuers = new Set(
    planning.status === "ready" ? planning.contracts.map(({ issuer }) => issuer) : [],
  );
  const replacements: ContractReplacementRequest[] = [];
  const replacingPredecessors = new Set<string>();
  const transitions: ContractTransitionRequest[] = [];
  if (planning.status === "ready") {
    for (const candidate of authorized) {
      const matches = planning.contracts.filter(
        ({ issuer }) => issuer === candidate.budgetRequest.issuer,
      );
      const predecessor = matches.length === 1 ? matches[0] : undefined;
      const categoryHandoff =
        predecessor !== undefined &&
        isRcl1ControllerCategoryHandoff(
          predecessor.budgetBinding.category,
          candidate.budgetRequest.category,
        );
      const sameFundingBinding =
        predecessor !== undefined &&
        predecessor.budgetBinding.category === candidate.budgetRequest.category &&
        predecessor.budgetBinding.issuer === candidate.budgetRequest.issuer;
      if (
        predecessor === undefined ||
        (!sameFundingBinding && !categoryHandoff) ||
        predecessor.issuerSequence === undefined ||
        candidate.budgetRequest.revision <= predecessor.issuerSequence
      )
        continue;
      const successorSequence = predecessor.issuerSequence + 1;
      const successor = contractFor({
        ...candidate,
        budgetRequest: { ...candidate.budgetRequest, revision: successorSequence },
      });
      const successorId = contractIdFor(
        successor.issuer,
        successor.issuerKey,
        successor.issuerSequence,
      );
      replacements.push({
        ...(categoryHandoff ? { fundingHandoff: RCL1_CONTROLLER_FUNDING_HANDOFF } : {}),
        predecessorContractId: predecessor.contractId,
        reason: "growth-budget-renewed",
        successor,
        tick,
      });
      replacingPredecessors.add(predecessor.contractId);
      // A missed prior handoff may leave durable budget identity ahead of its contract. Advance one
      // safe issuer sequence per tick; only the exact funded revision can become executable.
      if (successorSequence === candidate.budgetRequest.revision)
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
        if (!plannedIssuers.has(contract.issuer) && !reusable)
          transitions.push({
            contractId: contract.contractId,
            reason: "growth-target-resolved",
            tick,
            to: "cancelled",
          });
        else if (
          authorizedIssuers.has(contract.issuer) &&
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
        !plannedIssuers.has(contract.issuer) &&
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
      } else if (
        authorizedIssuers.has(contract.issuer) &&
        (contract.state === "proposed" || contract.state === "suspended")
      )
        transitions.push({
          contractId: contract.contractId,
          reason: "growth-work-remains",
          tick,
          to: "funded",
        });
    }
  }
  const replacingIssuers = new Set(replacements.map(({ successor }) => successor.issuer));
  return Object.freeze({
    candidates: Object.freeze(authorized),
    replacements: Object.freeze(
      replacements.sort((a, b) => a.predecessorContractId.localeCompare(b.predecessorContractId)),
    ),
    requests: Object.freeze(
      authorized
        .filter(
          ({ budgetRequest }) =>
            !replacingIssuers.has(budgetRequest.issuer) &&
            !existingIssuers.has(budgetRequest.issuer),
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
  usesCarriedEnergy = false,
  overrides: {
    readonly issuer?: string;
    readonly requiredCapability?: CapabilityVector;
  } = {},
): GrowthCandidate {
  return candidate(colonyId, "upgrade-controller", targetId, target, category, 0, config, {
    ...(overrides.issuer === undefined ? {} : { issuer: overrides.issuer }),
    ...(overrides.requiredCapability === undefined
      ? {}
      : { requiredCapability: overrides.requiredCapability }),
    usesCarriedEnergy,
  });
}

/**
 * One contract owns one primary lease, so RCL2 controller throughput must be represented by stable
 * lease slots rather than an unspawnable single 9-WORK request. Slot zero is a dedicated 350-energy
 * refill lane: its CARRY requirement is unavailable on a heavy upgrader and its smaller capability
 * surplus makes it the deterministic pickup/transfer choice while sinks need energy.
 * The remaining twelve lanes use the highest-throughput body that fits the official RCL2 550-energy
 * spawn pool while retaining the global 2:1 non-MOVE/MOVE ratio. The carrier's orthogonal CARRY
 * requirement prevents a heavy upgrader from satisfying its population objective by substitution.
 */
function rcl2ControllerUpgradeCandidates(
  colonyId: string,
  targetId: string,
  target: PositionSnapshot,
  config: RuntimeConfig,
): readonly GrowthCandidate[] {
  return Object.freeze(
    Array.from({ length: RCL2_CONTROLLER_UPGRADE_SLOTS }, (_, slot) =>
      upgradeCandidate(colonyId, targetId, target, "optional-growth", config, true, {
        issuer: `growth/${colonyId}/upgrade-controller/${targetId}/slot/${String(slot).padStart(2, "0")}`,
        requiredCapability: slot === 0 ? capability(1, 3, 2) : capability(3, 2, 3),
      }),
    ),
  );
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
  requiredCapability: CapabilityVector,
): GrowthCandidate {
  return candidate(colonyId, "build", targetId, target, "optional-growth", 0, config, {
    issuer: `growth/${colonyId}/rcl2-bootstrap/build/${targetId}`,
    reasonCode: "rcl2-infrastructure-bootstrap",
    requiredCapability,
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
    readonly requiredCapability?: CapabilityVector;
    readonly usesCarriedEnergy?: boolean;
  } = {},
): GrowthCandidate {
  const issuer = overrides.issuer ?? `growth/${colonyId}/${action}/${targetId}`;
  return {
    action,
    colonyId,
    order,
    requiredCapability: overrides.requiredCapability ?? capability(1, 1, 1),
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
      // Carried-energy work does not spend room energy. This leaves the full recovery reserve
      // untouched while RCL1 controller work or initial RCL2 construction consumes creep cargo.
      energy:
        category === "bootstrap-controller" ||
        overrides.reasonCode === "rcl2-infrastructure-bootstrap" ||
        overrides.usesCarriedEnergy === true
          ? null
          : { minimum: 1, desired: config.policy.growth.maximumEnergyPerTick },
      cpu: { minimum: 1, desired: 1 },
      spawn: null,
    },
  };
}
function contractFor(candidate: GrowthCandidate): WorkContractRequest {
  const controller = candidate.action === "upgrade-controller";
  const rcl2ControllerLane = isRcl2ControllerLane(candidate.budgetRequest.issuer);
  const rcl2ControllerSlot = isRcl2ControllerSlot(candidate.budgetRequest.issuer);
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
    leasePolicy: {
      duration: rcl2ControllerSlot ? RCL2_CONTROLLER_LEASE_DURATION : 10,
      switchingPenalty: 1,
      ttlSafetyMargin: 1,
    },
    maxAssignmentCost:
      candidate.budgetRequest.category === "bootstrap-controller" ||
      candidate.reasonCode === "rcl2-infrastructure-bootstrap" ||
      rcl2ControllerSlot
        ? BOOTSTRAP_MAX_ASSIGNMENT_COST
        : GROWTH_MAX_ASSIGNMENT_COST,
    owner: { id: candidate.colonyId, kind: "colony" },
    preconditionKeys: ["visible-growth-target"],
    priority: {
      // The small slot-00 worker remains available to refill the spawn pool. Heavy RCL2 controller
      // lanes rank just above ordinary survival transfers so a 3-energy room deficit cannot pin a
      // nearly full upgrader to a continuous trickle-fill lease for the rest of its cargo batch.
      class:
        candidate.budgetRequest.category === "controller-risk" || rcl2ControllerLane
          ? "survival"
          : "growth",
      value:
        candidate.budgetRequest.category === "controller-risk"
          ? 1_600
          : rcl2ControllerLane
            ? RCL2_CONTROLLER_LANE_PRIORITY
            : candidate.budgetRequest.category === "bootstrap-controller" ||
                candidate.reasonCode === "rcl2-infrastructure-bootstrap"
              ? 1_200
              : 500,
    },
    quantity: 1,
    range: 3,
    requiredCapability: candidate.requiredCapability,
    target: candidate.target,
    targetId: candidate.targetId,
  };
}

function capability(work: number, carry: number, move: number): CapabilityVector {
  return {
    attack: 0,
    carry,
    claim: 0,
    heal: 0,
    move,
    rangedAttack: 0,
    tough: 0,
    work,
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
    left.targetId.localeCompare(right.targetId) ||
    left.budgetRequest.issuer.localeCompare(right.budgetRequest.issuer)
  );
}

function qualifiesRcl1BootstrapPhase(
  room: WorldSnapshot["rooms"][number],
  config: RuntimeConfig,
): boolean {
  const controller = room.controller;
  return (
    controller?.ownership === "owned" &&
    controller.level === 1 &&
    room.energyAvailable === room.energyCapacityAvailable &&
    room.energyAvailable >= config.policy.recovery.protectedSpawnEnergy &&
    room.ownedExtensions.length === 0 &&
    room.ownedSpawns.filter(({ active }) => active).length === 1
  );
}

function hasViableEnergizedWorker(
  room: WorldSnapshot["rooms"][number],
  config: RuntimeConfig,
): boolean {
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

function qualifiesRcl2InfrastructureBootstrap(room: WorldSnapshot["rooms"][number]): boolean {
  const controller = room.controller;
  return (
    controller?.ownership === "owned" &&
    controller.level === 2 &&
    room.energyCapacityAvailable < RCL2_PROGRESSION_CAPACITY &&
    room.ownedSpawns.filter(({ active }) => active).length === 1
  );
}

function sameEnergyClaim(left: BudgetRequest["energy"], right: BudgetRequest["energy"]): boolean {
  return left === null
    ? right === null
    : right !== null && left.minimum === right.minimum && left.desired === right.desired;
}

function isRcl1ControllerCategoryHandoff(from: string, to: string): boolean {
  return (
    from !== to &&
    (from === "bootstrap-controller" || from === "controller-risk") &&
    (to === "bootstrap-controller" || to === "controller-risk")
  );
}

function isRcl2InfrastructureBootstrap(issuer: string): boolean {
  return issuer.includes("/rcl2-bootstrap/build/");
}

function isRcl2ControllerLane(issuer: string): boolean {
  return /\/upgrade-controller\/[^/]+\/slot\/(?:0[1-9]|1[0-2])$/u.test(issuer);
}

function isRcl2ControllerSlot(issuer: string): boolean {
  return /\/upgrade-controller\/[^/]+\/slot\/(?:0[0-9]|1[0-2])$/u.test(issuer);
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
  return (
    room.controller?.ownership === "owned" &&
    room.controller.level === 2 &&
    room.energyCapacityAvailable < RCL2_PROGRESSION_CAPACITY &&
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
