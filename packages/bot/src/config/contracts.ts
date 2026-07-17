export const RUNTIME_CONFIG_SCHEMA_VERSION = 1 as const;

export const FEATURE_GATE_IDS = [
  "phase1.colony",
  "phase1.contracts",
  "phase1.spawn",
  "phase1.movement",
  "phase1.agents",
  "phase1.economy",
  "phase1.recovery",
  "phase1.growth",
  "phase1.safety",
  "phase1.telemetry",
  "phase1.critical-maintenance",
  "phase2.colony",
  "phase2.layout",
  "phase2.mining",
  "phase2.logistics",
] as const;

export type FeatureGateId = (typeof FEATURE_GATE_IDS)[number];

export type FeatureGateReason =
  "enabled" | "source-unavailable" | "operator-disabled" | "prerequisite-blocked";

export interface FeatureGateDecision {
  readonly blockedBy: FeatureGateId | null;
  readonly enabled: boolean;
  readonly reason: FeatureGateReason;
}

export interface RuntimeFeatureGates {
  readonly disabled: readonly FeatureGateId[];
  readonly gates: Readonly<Record<FeatureGateId, FeatureGateDecision>>;
}

export const OBSERVER_DIAGNOSTIC_CATEGORIES = ["recovery", "blockers", "faults"] as const;
export type ObserverDiagnosticCategory = (typeof OBSERVER_DIAGNOSTIC_CATEGORIES)[number];
export type ObserverDiagnosticLevel = "debug" | "trace";

/** A time-bounded observer view. It cannot modify operational policy. */
export interface ObserverDiagnosticWindow {
  readonly level: ObserverDiagnosticLevel;
  readonly categories: readonly ObserverDiagnosticCategory[];
  readonly expiresAtTick: number;
}

export interface RecoveryPolicy {
  /** Energy protected for restoring a legal local workforce. */
  readonly protectedSpawnEnergy: number;
  /** Maximum energy allocated to the deterministic emergency worker. */
  readonly emergencyWorkerEnergyBudget: number;
  /** Controller downgrade horizon that becomes a survival risk. */
  readonly controllerRiskWindowTicks: number;
}

export interface LeasePolicy {
  readonly durationTicks: number;
  readonly renewalWindowTicks: number;
}

export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly initialDelayTicks: number;
  readonly maximumDelayTicks: number;
}

export interface MovementPolicy {
  readonly maximumSearchOperations: number;
  readonly maximumPathCost: number;
  readonly stuckReplanTicks: number;
  readonly blockedReleaseTicks: number;
}

export interface SpawnPolicy {
  readonly maximumBodyParts: number;
  readonly maximumBodyEnergy: number;
  readonly maximumNonMovePartsPerMovePart: number;
  readonly replacementSafetyMarginTicks: number;
  readonly nameCollisionRetryLimit: number;
}

export interface CriticalRepairPolicy {
  readonly criticalHitsBasisPoints: number;
  readonly completionHitsBasisPoints: number;
  readonly maximumActiveContractsPerRoom: number;
  readonly maximumEnergyPerTick: number;
}

/** Bounded discretionary work admitted only after the protected survival reserve. */
export interface GrowthPolicy {
  readonly minimumSurplusEnergy: number;
  readonly maximumActiveContractsPerRoom: number;
  readonly maximumEnergyPerTick: number;
}

/** Hard caps for observer-only telemetry; never an input to gameplay admission. */
export interface TelemetryPolicy {
  readonly maximumDetailRecords: number;
  readonly maximumHistoryEntries: number;
  readonly maximumHistoryBytes: number;
}

export const REPORTER_LEVELS = ["silent", "error", "warn", "info", "debug", "trace"] as const;
export type ReporterLevel = (typeof REPORTER_LEVELS)[number];

/** Source-controlled ceilings for observer-only console reporting. */
export interface ReporterPolicy {
  readonly baseLevel: ReporterLevel;
  readonly heartbeatIntervalTicks: number;
  readonly maximumLinesPerTick: number;
  readonly maximumBytesPerTick: number;
  readonly maximumImmediateEventsPerTick: number;
  /** Maximum tick-local health signals inspected before reporter aggregation fails closed. */
  readonly maximumSignalsPerTick: number;
  readonly maximumFingerprints: number;
  readonly initialReminderDelayTicks: number;
  readonly maximumReminderDelayTicks: number;
  /** Unchanged safe recovery evidence for this long is reported as stuck. */
  readonly stuckRecoveryWindowTicks: number;
  readonly maximumDiagnosticDurationTicks: number;
}

export interface TowerPolicy {
  readonly emergencyReserveEnergy: number;
  readonly repairMinimumEnergy: number;
}

export interface SafeModePolicy {
  readonly enabled: boolean;
  readonly criticalAssetHitsBasisPoints: number;
  readonly lossPredictionHorizonTicks: number;
  readonly minimumHostileOffenseParts: number;
  readonly retryDelayTicks: number;
}

export interface SurvivalPolicy {
  readonly colony: ColonyPolicy;
  readonly recovery: RecoveryPolicy;
  readonly leases: LeasePolicy;
  readonly retries: RetryPolicy;
  readonly movement: MovementPolicy;
  readonly spawn: SpawnPolicy;
  readonly repair: CriticalRepairPolicy;
  readonly growth: GrowthPolicy;
  readonly telemetry: TelemetryPolicy;
  readonly reporter: ReporterPolicy;
  readonly tower: TowerPolicy;
  readonly safeMode: SafeModePolicy;
}

/** Source-versioned complete-colony policy. Operational overrides cannot advance this version. */
export interface ColonyPolicy {
  readonly rclPolicyVersion: 1;
  readonly populationPolicyVersion: 1;
  readonly populationPlanningHorizonTicks: 50;
  readonly populationSpawnUtilizationCeilingBasisPoints: 9_000;
  readonly populationMaximumDemandsPerColony: 8;
}

export interface ConfiguredRelations {
  readonly self: readonly string[];
  readonly allies: readonly string[];
  readonly naps: readonly string[];
}

export interface RuntimeConfig {
  readonly schemaVersion: typeof RUNTIME_CONFIG_SCHEMA_VERSION;
  readonly sourceRevision: string;
  /** Compact identity for the full canonical resolved configuration. */
  readonly revision: string;
  /** Compact identity for the canonical survival policy. */
  readonly policyRevision: string;
  readonly policy: SurvivalPolicy;
  readonly relations: ConfiguredRelations;
  readonly features: RuntimeFeatureGates;
  readonly observer: { readonly diagnostic: ObserverDiagnosticWindow | null };
}

export const PLAYER_RELATIONS = [
  "self",
  "ally",
  "nap",
  "neutral",
  "trespasser",
  "hostile",
  "war",
] as const;

export type PlayerRelation = (typeof PLAYER_RELATIONS)[number];

export const TARGETING_CEILINGS = ["excluded", "local-defense", "authorized-operation"] as const;

export type TargetingCeiling = (typeof TARGETING_CEILINGS)[number];

export type ReputationStatus = "not-consulted" | "absent" | "fresh" | "stale" | "invalid";

export type RelationDecisionReason =
  | "configured-self"
  | "configured-ally"
  | "configured-nap"
  | "invalid-observed-identity"
  | "reputation-absent"
  | "reputation-invalid"
  | "reputation-stale"
  | "reputation-exclusion"
  | "reputation-advisory";

export interface RelationDecisionRequest {
  readonly username: unknown;
  readonly tick: number;
  readonly reputation?: unknown;
}

export interface RelationDecision {
  readonly relation: PlayerRelation;
  /** A ceiling is never sufficient authorization to issue an action. */
  readonly targetingCeiling: TargetingCeiling;
  readonly reasonCode: RelationDecisionReason;
  readonly reputationStatus: ReputationStatus;
  readonly configRevision: string;
  readonly policyRevision: string;
}
