import type { CpuMode } from "../runtime/kernel";
import {
  COLONY_CAPABILITY_DOMAINS,
  type ColonyCapabilityDomain,
  type ColonyDomainHealthProjection,
  type ColonyRclPolicyProjection,
  type ColonyRclPolicyReason,
  type ColonyView,
  type ColonyRclUnlockAllowances,
  type ColonyState,
} from "./contracts";

export interface ColonyRclPolicyObservation {
  readonly visibility: "visible" | "unknown";
  readonly state: ColonyState;
  readonly controllerLevel: number | null;
  readonly energyAvailable: number | null;
  readonly energyCapacityAvailable: number | null;
  readonly activeThreat: boolean | null;
  readonly controllerRisk: boolean | null;
  readonly cpuMode: CpuMode;
  readonly protectedSpawnEnergy: number;
  readonly rcl8Health: ColonyDomainHealthProjection | null;
}
interface RclPolicyRow {
  readonly level: number;
  readonly spawnPoolCapacityTarget: number;
  readonly unlocks: ColonyRclUnlockAllowances;
}
export const COLONY_RCL_POLICY_TABLE: readonly RclPolicyRow[] = deepFreeze([
  row(2, 550, 1, 5, 0, 0, 5, true, true, 0, 0, 0, 0, 0, 0, 0, 0),
  row(3, 800, 1, 10, 1, 0, 5, true, true, 0, 0, 0, 0, 0, 0, 0, 0),
  row(4, 1300, 1, 20, 1, 0, 5, true, true, 1, 0, 0, 0, 0, 0, 0, 0),
  row(5, 1800, 1, 30, 2, 2, 5, true, true, 1, 0, 0, 0, 0, 0, 0, 0),
  row(6, 2300, 1, 40, 2, 3, 5, true, true, 1, 1, 3, 1, 0, 0, 0, 0),
  row(7, 5600, 2, 50, 3, 4, 5, true, true, 1, 1, 6, 1, 1, 0, 0, 0),
  row(8, 12900, 3, 60, 6, 6, 5, true, true, 1, 1, 10, 1, 1, 1, 1, 1),
]);
const ROWS = new Map(COLONY_RCL_POLICY_TABLE.map((entry) => [entry.level, entry]));
const MINIMUM_RCL: Readonly<Record<ColonyCapabilityDomain, number>> = Object.freeze({
  mining: 2,
  logistics: 2,
  construction: 2,
  maintenance: 2,
  defense: 3,
  storage: 4,
  terminal: 6,
  industry: 6,
});

export function isInfrastructureRecoveryAuthorized(
  colony: Pick<
    ColonyView,
    | "activeThreat"
    | "controllerRisk"
    | "domainHealth"
    | "legalWorkforce"
    | "rclPolicy"
    | "state"
    | "visibility"
  >,
): boolean {
  return (
    colony.visibility === "visible" &&
    (colony.state === "recovering" ||
      (colony.state === "developing" &&
        colony.rclPolicy.progression.reasonCode === "rcl8-health-evidence-unavailable")) &&
    colony.domainHealth.status === "blocked" &&
    colony.legalWorkforce === true &&
    colony.activeThreat === false &&
    colony.controllerRisk === false &&
    colony.rclPolicy.level === 8 &&
    colony.rclPolicy.protectedSpawnReserve.state === "restored"
  );
}

export function projectColonyRclPolicy(
  observation: ColonyRclPolicyObservation,
): ColonyRclPolicyProjection {
  const policyRow =
    observation.visibility === "visible" && observation.controllerLevel !== null
      ? (ROWS.get(observation.controllerLevel) ?? null)
      : null;
  const available = observation.visibility === "visible" ? observation.energyAvailable : null;
  const reserveState =
    available === null
      ? "unknown"
      : available >= observation.protectedSpawnEnergy
        ? "restored"
        : "unrestored";
  const reasonCode = reason(observation, policyRow, reserveState);
  return deepFreeze({
    version: 1,
    level: policyRow?.level ?? null,
    spawnPoolCapacityTarget: policyRow?.spawnPoolCapacityTarget ?? null,
    unlocks: policyRow?.unlocks ?? null,
    protectedSpawnReserve: {
      target: observation.protectedSpawnEnergy,
      available,
      state: reserveState,
    },
    domains: COLONY_CAPABILITY_DOMAINS.map((domain) => ({
      domain,
      posture:
        policyRow !== null && policyRow.level >= MINIMUM_RCL[domain]
          ? ("available" as const)
          : ("locked" as const),
    })),
    progression: {
      status:
        reasonCode === "active"
          ? "authorized"
          : reasonCode === "sustaining"
            ? "sustaining"
            : "blocked",
      authorized: reasonCode === "active" || reasonCode === "sustaining",
      reasonCode,
    },
  });
}
function reason(
  o: ColonyRclPolicyObservation,
  policyRow: RclPolicyRow | null,
  reserve: "unknown" | "unrestored" | "restored",
): ColonyRclPolicyReason {
  if (o.visibility === "unknown") return "observation-unknown";
  if (o.state === "lost") return "colony-lost";
  if (policyRow === null) return "outside-rcl2-rcl8";
  if (o.activeThreat === true || o.state === "threatened") return "threat-preemption";
  if (o.state === "recovering") return "recovery-preemption";
  if (o.state === "bootstrapping") return "bootstrap-preemption";
  if (o.cpuMode !== "normal") return "constrained-cpu-preemption";
  if (o.controllerRisk !== false) return "controller-downgrade-risk";
  if (reserve !== "restored") return "protected-spawn-reserve-unrestored";
  if (
    o.energyCapacityAvailable === null ||
    o.energyCapacityAvailable < policyRow.spawnPoolCapacityTarget
  )
    return "spawn-pool-capacity-below-target";
  if (policyRow.level === 8) {
    return o.rcl8Health?.status === "healthy" ? "sustaining" : "rcl8-health-evidence-unavailable";
  }
  return "active";
}
function row(
  level: number,
  spawnPoolCapacityTarget: number,
  spawns: number,
  extensions: number,
  towers: number,
  links: number,
  containers: number,
  ramparts: boolean,
  walls: boolean,
  storage: number,
  terminal: number,
  labs: number,
  extractor: number,
  factory: number,
  observer: number,
  powerSpawn: number,
  nuker: number,
): RclPolicyRow {
  return {
    level,
    spawnPoolCapacityTarget,
    unlocks: {
      spawns,
      extensions,
      towers,
      links,
      containers,
      ramparts,
      walls,
      storage,
      terminal,
      labs,
      extractor,
      factory,
      observer,
      powerSpawn,
      nuker,
    },
  };
}
function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
