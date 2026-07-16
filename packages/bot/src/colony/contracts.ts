export const COLONY_OWNER_SCHEMA_VERSION = 1 as const;

export const COLONY_STATES = [
  "discovering",
  "bootstrapping",
  "developing",
  "mature",
  "threatened",
  "recovering",
  "lost",
] as const;

export type ColonyState = (typeof COLONY_STATES)[number];

export const COLONY_TRANSITION_REASONS = [
  "owned-room-discovered",
  "spawn-without-workforce",
  "survival-capability-restored",
  "maturity-evidence-met",
  "maturity-evidence-lost",
  "local-threat-observed",
  "local-threat-cleared",
  "controller-downgrade-risk",
  "survival-capability-lost",
  "mandatory-floor-unrestored",
  "visible-ownership-lost",
  "observation-unknown",
  "lost-terminal",
] as const;

export type ColonyTransitionReason = (typeof COLONY_TRANSITION_REASONS)[number];

export const BUDGET_CATEGORIES = [
  "emergency-spawn",
  "defense",
  "replacement",
  "harvesting-filling",
  "controller-risk",
  "bootstrap-controller",
  "critical-maintenance",
  "optional-growth",
] as const;

export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

export const LEDGER_ENTRY_STATUSES = [
  "pending",
  "active",
  "consumed",
  "released",
  "expired",
] as const;

export type LedgerEntryStatus = (typeof LEDGER_ENTRY_STATUSES)[number];

export const BUDGET_REASON_CODES = [
  "granted",
  "granted-reduced",
  "already-granted",
  "consumed",
  "already-consumed",
  "released",
  "already-released",
  "expired",
  "already-expired",
  "reconciled",
  "superseded",
  "objective-satisfied",
  "capacity-reconciled",
  "posture-preempted",
  "protected-energy-floor",
  "insufficient-energy",
  "insufficient-cpu",
  "spawn-not-observed",
  "spawn-observed-busy",
  "spawn-interval-overlap",
  "invalid-request",
  "revision-reused",
  "stale-revision",
  "request-cap-exceeded",
  "reservation-cap-exceeded",
  "ledger-entry-cap-exceeded",
  "transition-cap-exceeded",
  "reservation-not-found",
  "consumption-regressed",
  "consumption-exceeded",
  "owner-malformed",
  "owner-future-schema",
  "owner-unavailable",
  "observation-unknown",
  "colony-lost",
] as const;

export type BudgetReasonCode = (typeof BUDGET_REASON_CODES)[number];

export const COLONY_PLAN_STATUSES = [
  "planned",
  "disabled",
  "owner-unavailable",
  "owner-malformed",
  "owner-future-schema",
  "not-run",
] as const;

export type ColonyPlanStatus = (typeof COLONY_PLAN_STATUSES)[number];

export const COLONY_PLAN_REASONS = [
  "planned",
  "feature-disabled",
  "owner-unavailable",
  "owner-malformed",
  "owner-future-schema",
  "not-run",
] as const;

export type ColonyPlanReason = (typeof COLONY_PLAN_REASONS)[number];

/** Structural safety limits. They are source invariants, not operational policy. */
export const MAX_COLONIES = 64 as const;
export const MAX_BUDGET_REQUESTS_PER_TICK = 256 as const;
export const MAX_ACTIVE_RESERVATIONS = 256 as const;
export const MAX_LEDGER_ENTRIES = 512 as const;
export const MAX_LEDGER_TRANSITIONS_PER_TICK = 1_024 as const;
export const MAX_BUDGET_ISSUER_CODE_UNITS = 128 as const;
export const MAX_RESERVATION_ID_CODE_UNITS = 384 as const;
export const MAX_SPAWN_INTERVAL_TICKS = 150 as const;
export const CPU_RESERVATION_UNITS_PER_CPU = 1_000 as const;
export const RECOVERY_OBJECTIVE_CPU_UNITS = 100 as const;

export interface ElasticBudgetClaim {
  readonly minimum: number;
  readonly desired: number;
}

export interface SpawnIntervalClaim {
  readonly spawnId: string;
  readonly startTick: number;
  readonly endTick: number;
}

export interface BudgetRequest {
  readonly colonyId: string;
  readonly category: BudgetCategory;
  readonly issuer: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly energy: ElasticBudgetClaim | null;
  readonly cpu: ElasticBudgetClaim | null;
  /** Exact half-open interval supplied by the spawn-slot authority. */
  readonly spawn: SpawnIntervalClaim | null;
}

export interface BudgetGrant {
  readonly energy: number;
  readonly cpu: number;
  readonly spawn: SpawnIntervalClaim | null;
}

export interface BudgetConsumption {
  /** Cumulative totals make repeated command reconciliation idempotent. */
  readonly energy: number;
  readonly cpu: number;
  readonly spawn: boolean;
}

export interface LedgerEntry {
  readonly reservationId: string;
  readonly colonyId: string;
  readonly category: BudgetCategory;
  readonly issuer: string;
  readonly revision: number;
  readonly request: BudgetRequest;
  readonly grant: BudgetGrant;
  readonly consumed: BudgetConsumption;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: LedgerEntryStatus;
  readonly reasonCode: BudgetReasonCode;
}

export interface ColonyRecord {
  readonly roomName: string;
  readonly state: ColonyState;
  readonly stateSince: number;
  readonly revision: number;
  readonly policyRevision: string;
  readonly reasonCode: ColonyTransitionReason;
}

export interface ColoniesOwnerV1 {
  readonly schemaVersion: typeof COLONY_OWNER_SCHEMA_VERSION;
  readonly revision: number;
  readonly colonies: readonly ColonyRecord[];
  readonly ledger: readonly LedgerEntry[];
}

export interface ColonyEnergyCapacity {
  readonly colonyId: string;
  readonly available: number;
  readonly protected: number;
}

export interface SpawnBudgetCapacity {
  readonly colonyId: string;
  readonly spawnId: string;
  readonly blocked: readonly SpawnIntervalClaim[];
}

export interface BudgetLedgerCapacity {
  readonly energy: readonly ColonyEnergyCapacity[];
  readonly cpu: number;
  readonly spawns: readonly SpawnBudgetCapacity[];
}

export type BudgetDecisionStatus = "granted" | "retained" | "denied";

export interface BudgetDecision {
  readonly reservationId: string;
  readonly colonyId: string;
  readonly category: BudgetCategory;
  readonly issuer: string;
  readonly revision: number;
  readonly status: BudgetDecisionStatus;
  readonly reasonCode: BudgetReasonCode;
  readonly grant: BudgetGrant | null;
}

export type LedgerTransitionAction = "grant" | "retain" | "consume" | "release" | "expire";

export interface LedgerTransition {
  readonly reservationId: string;
  readonly action: LedgerTransitionAction;
  readonly reasonCode: BudgetReasonCode;
}

export interface BudgetLedgerTotals {
  readonly active: number;
  readonly pending: number;
  readonly energyReserved: number;
  readonly cpuReserved: number;
  readonly spawnTicksReserved: number;
}

export interface BudgetLedgerResult {
  readonly entries: readonly LedgerEntry[];
  readonly decisions: readonly BudgetDecision[];
  readonly transitions: readonly LedgerTransition[];
  readonly totals: BudgetLedgerTotals;
}

export interface RecoveryCapabilityDemand {
  readonly kind: "recovery-worker";
  readonly work: 1;
  readonly carry: 1;
  readonly move: 1;
}

export interface ColonyObjective {
  readonly id: string;
  readonly colonyId: string;
  readonly kind: "restore-workforce";
  readonly category: "emergency-spawn";
  readonly revision: number;
  readonly reasonCode: "recovery-workforce-missing";
  readonly status: "funded" | "blocked";
  readonly budgetReasonCode: BudgetReasonCode;
  readonly reservationId: string | null;
  readonly demand: RecoveryCapabilityDemand;
}

export interface ColonyView {
  readonly id: string;
  readonly roomName: string;
  readonly state: ColonyState;
  readonly revision: number;
  readonly reasonCode: ColonyTransitionReason;
  readonly visibility: "visible" | "unknown";
  readonly legalWorkforce: boolean | null;
  readonly activeThreat: boolean | null;
  readonly controllerRisk: boolean | null;
}

export interface ColonyPlanningResult {
  readonly status: ColonyPlanStatus;
  readonly reasonCode: ColonyPlanReason;
  readonly ownerRevision: number | null;
  readonly colonies: readonly ColonyView[];
  readonly objectives: readonly ColonyObjective[];
  readonly decisions: readonly BudgetDecision[];
  readonly reservations: readonly LedgerEntry[];
  readonly transitions: readonly LedgerTransition[];
  readonly totals: BudgetLedgerTotals;
}

export interface ColonyDirectorResult extends ColonyPlanningResult {
  readonly replacementOwner: ColoniesOwnerV1 | null;
}
