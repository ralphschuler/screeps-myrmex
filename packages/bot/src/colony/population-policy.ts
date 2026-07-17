import {
  CAPABILITY_KEYS,
  type CapabilityVector,
  type ContractPopulationView,
  type WorkforceActor,
} from "../contracts";
import type { CpuMode } from "../runtime/kernel";
import {
  BUDGET_CATEGORIES,
  type BudgetCategory,
  type ColonyCapabilityDemand,
  type ColonyPopulationProjection,
  type ColonyState,
} from "./contracts";

export const POPULATION_PLANNING_HORIZON_TICKS = 50;
export const MAX_POPULATION_OBJECTIVES = 64;
export const MAX_POPULATION_DEMANDS = 8;
export const MAX_POPULATION_COPIES_PER_OBJECTIVE = 8;
export const MAX_POPULATION_TARGET_PARTS = 256;
export const POPULATION_SPAWN_SATURATION_BASIS_POINTS = 9_000;
export const MAX_POPULATION_TRAVEL_TICKS = 150;

type MutableCapability = { -readonly [Key in keyof CapabilityVector]: number };

const ZERO = (): MutableCapability => ({
  attack: 0,
  carry: 0,
  claim: 0,
  heal: 0,
  move: 0,
  rangedAttack: 0,
  tough: 0,
  work: 0,
});
const COST: Readonly<Record<keyof CapabilityVector, number>> = Object.freeze({
  attack: 80,
  carry: 50,
  claim: 600,
  heal: 250,
  move: 50,
  rangedAttack: 150,
  tough: 10,
  work: 100,
});
const OPTIONAL = new Set<BudgetCategory>([
  "bootstrap-controller",
  "maintenance",
  "optional-growth",
]);
const RESERVE_ALLOWED = new Set<BudgetCategory>(["emergency-spawn", "defense", "replacement"]);

export interface ColonyPopulationPolicyInput {
  readonly activeThreat: boolean | null;
  readonly actors: readonly WorkforceActor[];
  readonly availableEnergy: number;
  readonly colonyId: string;
  readonly committedDemandIds: readonly string[];
  readonly controllerRisk: boolean | null;
  readonly cpuMode: CpuMode;
  readonly funded: ContractPopulationView;
  readonly maximumBodyEnergy: number;
  readonly protectedSpawnEnergy: number;
  readonly replacementLeadTicks: number;
  readonly spawnUtilizationBasisPoints: number;
  readonly spawnBusyTicks?: number;
  readonly state: ColonyState;
  readonly visibility: "visible" | "unknown";
}

export class ColonyPopulationPolicy {
  public project(input: ColonyPopulationPolicyInput): ColonyPopulationProjection {
    const supplied = supply(input.actors, input.replacementLeadTicks);
    if (input.visibility === "unknown")
      return result("blocked", "observation-unknown", ZERO(), supplied, ZERO(), [], 0, 0);
    if (input.state === "lost")
      return result("blocked", "colony-lost", ZERO(), supplied, ZERO(), [], 0, 0);
    const raw =
      input.funded.status === "ready"
        ? input.funded.loads.filter((load) => load.colonyId === input.colonyId)
        : [];
    const loads = [...raw].sort(compareLoads).slice(0, MAX_POPULATION_OBJECTIVES);
    const truncatedObjectives = Math.max(0, raw.length - loads.length);
    if (loads.length === 0)
      return result(
        "satisfied",
        "no-funded-objectives",
        ZERO(),
        supplied,
        ZERO(),
        [],
        truncatedObjectives,
        0,
      );

    const remainingSupply = { ...supplied };
    const target = ZERO();
    const deficit = ZERO();
    const candidates: ColonyCapabilityDemand[] = [];
    let targetParts = 0;
    let preempted: ColonyPopulationProjection["reasonCode"] | null = null;

    for (const load of loads) {
      const category = budgetCategory(load.category);
      if (category === null) continue;
      const reason = preemption(input, category);
      if (reason !== null) {
        preempted ??= reason;
        continue;
      }
      const productive = Math.min(
        load.sourceCapacityWorkTicks,
        load.measuredWorkTicks + Math.min(load.backlogWorkTicks, POPULATION_PLANNING_HORIZON_TICKS),
      );
      if (productive === 0) continue;
      const roundTrip =
        load.mode === "stationary" || load.mode === "logistics"
          ? 0
          : Math.min(
              load.travelTicks * 2,
              POPULATION_PLANNING_HORIZON_TICKS,
              MAX_POPULATION_TRAVEL_TICKS * 2,
            );
      const travelOverhead = Math.ceil(
        (productive * roundTrip) / POPULATION_PLANNING_HORIZON_TICKS,
      );
      const copies =
        load.mode === "stationary" || load.mode === "logistics"
          ? 1
          : Math.min(
              MAX_POPULATION_COPIES_PER_OBJECTIVE,
              Math.ceil((productive + travelOverhead) / POPULATION_PLANNING_HORIZON_TICKS),
            );
      const partsPerCopy = total(load.minimumCapability);
      const boundedCopies =
        partsPerCopy === 0
          ? 0
          : Math.min(
              copies,
              Math.floor((MAX_POPULATION_TARGET_PARTS - targetParts) / partsPerCopy),
            );
      if (boundedCopies === 0) continue;
      const objectiveSupply: MutableCapability =
        load.mode === "stationary" || load.mode === "logistics"
          ? {
              ...supply(
                input.actors,
                input.replacementLeadTicks +
                  load.travelTicks +
                  total(load.minimumCapability) * 3 +
                  (input.spawnBusyTicks ?? 0),
              ),
            }
          : remainingSupply;
      targetParts += partsPerCopy * boundedCopies;
      const missing = ZERO();
      for (const key of CAPABILITY_KEYS) {
        const required = load.minimumCapability[key] * boundedCopies;
        target[key] += required;
        const covered = Math.min(required, objectiveSupply[key]);
        objectiveSupply[key] -= covered;
        missing[key] = required - covered;
        deficit[key] += missing[key];
      }
      const missingCopies = Math.min(
        boundedCopies,
        Math.max(
          ...CAPABILITY_KEYS.map((key) =>
            load.minimumCapability[key] === 0
              ? 0
              : Math.ceil(missing[key] / load.minimumCapability[key]),
          ),
        ),
      );
      for (let slot = 0; slot < missingCopies; slot += 1) {
        const id = demandId(input.colonyId, load.objectiveId, load.revision, slot);
        candidates.push({
          category,
          colonyId: input.colonyId,
          energyCap: input.maximumBodyEnergy,
          id,
          objectiveId: load.objectiveId,
          requiredCapability: { ...load.minimumCapability },
          reservationId: load.reservationId,
          revision: load.revision,
        });
      }
    }

    if (total(deficit) === 0)
      return result(
        "satisfied",
        preempted ?? "capability-satisfied",
        target,
        supplied,
        deficit,
        [],
        truncatedObjectives,
        0,
      );
    const committed = new Set(input.committedDemandIds);
    const demands: ColonyCapabilityDemand[] = [];
    let energy = input.availableEnergy;
    let blocked: ColonyPopulationProjection["reasonCode"] | null = preempted;
    for (const candidate of candidates) {
      if (demands.length >= MAX_POPULATION_DEMANDS) break;
      const cost = bodyCost(candidate.requiredCapability);
      if (committed.has(candidate.id)) {
        blocked ??= "duplicate-commitment";
        energy = Math.max(0, energy - cost);
        continue;
      }
      if (cost > energy || cost > input.maximumBodyEnergy) {
        blocked ??= "insufficient-available-energy";
        continue;
      }
      if (!RESERVE_ALLOWED.has(candidate.category) && energy - cost < input.protectedSpawnEnergy) {
        blocked ??= "protected-spawn-reserve";
        continue;
      }
      demands.push({ ...candidate, energyCap: Math.min(energy, input.maximumBodyEnergy) });
      energy -= cost;
    }
    const truncatedDemands = Math.max(0, candidates.length - demands.length);
    return demands.length > 0
      ? result(
          "demanded",
          "demanded",
          target,
          supplied,
          deficit,
          demands,
          truncatedObjectives,
          truncatedDemands,
        )
      : result(
          "blocked",
          blocked ?? "insufficient-available-energy",
          target,
          supplied,
          deficit,
          [],
          truncatedObjectives,
          truncatedDemands,
        );
  }
}

function preemption(
  input: ColonyPopulationPolicyInput,
  category: BudgetCategory,
): ColonyPopulationProjection["reasonCode"] | null {
  if (!OPTIONAL.has(category)) return null;
  if (input.activeThreat === true || input.state === "threatened") return "threat-preemption";
  if (input.state === "recovering") return "recovery-preemption";
  if (input.state === "bootstrapping") return "bootstrap-preemption";
  if (input.cpuMode !== "normal") return "constrained-cpu-preemption";
  if (input.controllerRisk !== false) return "controller-downgrade-preemption";
  if (input.spawnUtilizationBasisPoints >= POPULATION_SPAWN_SATURATION_BASIS_POINTS)
    return "spawn-saturated";
  return null;
}
function supply(actors: readonly WorkforceActor[], lead: number): CapabilityVector {
  const value = ZERO();
  for (const actor of [...actors].sort((a, b) => a.id.localeCompare(b.id))) {
    if (actor.spawning || actor.ticksToLive === null || actor.ticksToLive <= lead) continue;
    for (const key of CAPABILITY_KEYS)
      value[key] = Math.min(MAX_POPULATION_TARGET_PARTS, value[key] + actor.capability[key]);
  }
  return value;
}
function compareLoads(
  a: ContractPopulationView["loads"][number],
  b: ContractPopulationView["loads"][number],
): number {
  return (
    rank(a.category) - rank(b.category) ||
    a.objectiveId.localeCompare(b.objectiveId) ||
    a.revision - b.revision
  );
}
function rank(category: string): number {
  const index = BUDGET_CATEGORIES.indexOf(category as BudgetCategory);
  return index < 0 ? BUDGET_CATEGORIES.length : index;
}
function budgetCategory(value: string): BudgetCategory | null {
  return BUDGET_CATEGORIES.includes(value as BudgetCategory) ? (value as BudgetCategory) : null;
}
function total(value: CapabilityVector): number {
  return CAPABILITY_KEYS.reduce((sum, key) => sum + value[key], 0);
}
function bodyCost(value: CapabilityVector): number {
  return CAPABILITY_KEYS.reduce((sum, key) => sum + value[key] * COST[key], 0);
}
function demandId(colony: string, objective: string, revision: number, slot: number): string {
  let hash = 0x811c9dc5;
  for (const char of objective) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `population/${colony}/${(hash >>> 0).toString(16).padStart(8, "0")}/${revision.toString(36)}/${slot.toString(36)}`;
}
function result(
  status: ColonyPopulationProjection["status"],
  reasonCode: ColonyPopulationProjection["reasonCode"],
  targetCapability: CapabilityVector,
  suppliedCapability: CapabilityVector,
  deficitCapability: CapabilityVector,
  demands: readonly ColonyCapabilityDemand[],
  truncatedObjectives: number,
  truncatedDemands: number,
): ColonyPopulationProjection {
  return deepFreeze({
    version: 1,
    status,
    reasonCode,
    targetCapability,
    suppliedCapability,
    deficitCapability,
    demands: [...demands],
    truncatedObjectives,
    truncatedDemands,
  });
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
