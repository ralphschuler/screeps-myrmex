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
  readonly maximumFingerprints: number;
  readonly initialReminderDelayTicks: number;
  readonly maximumReminderDelayTicks: number;
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
