import type { RuntimeConfig } from "../config";
import type {
  ContractExecutionView,
  ContractTransitionRequest,
  LeaseTravelOverride,
} from "../contracts";
import type { CreepSnapshot } from "../world/snapshot";
import type { RoutePlanResult } from "../world/routes";
import type { RemoteCandidateEvidence, RemotePortfolioDisposition } from "./contracts";

export const REMOTE_SAFETY_LIMITS = Object.freeze({
  maximumAssessmentCpuMilli: 25,
  maximumEvidencePerTick: 8,
  maximumIdentityCodeUnits: 128,
  maximumMovementPriority: 1_000_000,
  maximumPortfolioDispositions: 32,
  maximumRouteRooms: 16,
  maximumThreatRisk: 10_000,
} as const);

export interface RemoteSafetyPolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly assessmentCpuMilli: number;
  readonly evacuationMovementPriority: number;
  readonly maximumIntelAgeTicks: number;
  readonly maximumRecentLossBasisPoints: number;
  readonly minimumConfidenceBasisPoints: number;
  readonly invaderCoreDeploymentLeadTicks: number;
  readonly threatRisk: number;
}

export interface RemoteSafetyEvidence {
  readonly candidate: RemoteCandidateEvidence;
  readonly confidenceBasisPoints: number;
  readonly evacuationRoute: RoutePlanResult;
  readonly recentLossBasisPoints: number;
}

export type RemoteSafetyReason =
  | "confidence-low"
  | "credible-hostile"
  | "excluded-presence"
  | "harmless-presence"
  | "intel-partial"
  | "intel-stale"
  | "intel-unavailable"
  | "invader-core"
  | "loss-risk"
  | "recent-attack"
  | "route-threat"
  | "safe";

export interface RemoteSafetyAssessment {
  readonly confidenceBasisPoints: number;
  readonly evidenceRevision: string;
  readonly reason: RemoteSafetyReason;
  readonly recentLossBasisPoints: number;
  readonly roomName: string;
  readonly threatRisk: number;
}

export interface RemoteSafetyMetrics {
  readonly assessed: number;
  readonly cpuMilli: number;
  readonly credibleThreats: number;
  readonly excludedCreeps: number;
  readonly harmlessCreeps: number;
  readonly unsafe: number;
}

export interface RemoteSafetyAssessmentInput {
  readonly availableCpuMilli: number;
  readonly config: RuntimeConfig;
  readonly evidence: readonly RemoteSafetyEvidence[];
  readonly policy: RemoteSafetyPolicyV1;
  readonly tick: number;
}

export interface RemoteSafetyAssessmentResult {
  readonly assessments: readonly RemoteSafetyAssessment[];
  readonly candidates: readonly RemoteCandidateEvidence[];
  readonly metrics: RemoteSafetyMetrics;
  readonly status: "ready" | "invalid-input" | "limit-exceeded" | "cpu-budget";
}

export type RemoteEvacuationReason =
  "actor-lost" | "cargo-returning" | "evacuated" | "evacuating" | "route-unavailable";

export interface RemoteEvacuationDisposition {
  readonly actorId: string;
  readonly contractId: string;
  readonly reason: RemoteEvacuationReason;
  readonly roomName: string;
}

export interface RemoteEvacuationPlanInput {
  readonly actors: readonly CreepSnapshot[];
  readonly assessments: readonly RemoteSafetyAssessment[];
  readonly evidence: readonly RemoteSafetyEvidence[];
  readonly execution: ContractExecutionView;
  readonly policy: RemoteSafetyPolicyV1;
  /** Existing portfolio hysteresis keeps a started evacuation active until the remote is active. */
  readonly portfolioDispositions?: readonly RemotePortfolioDisposition[];
  readonly tick: number;
}

export interface RemoteEvacuationMetrics {
  readonly actors: number;
  readonly cargoReturning: number;
  readonly evacuated: number;
  readonly evacuating: number;
  readonly lost: number;
  readonly routeUnavailable: number;
}

export interface RemoteEvacuationPlan {
  readonly dispositions: readonly RemoteEvacuationDisposition[];
  readonly metrics: RemoteEvacuationMetrics;
  readonly overrides: readonly LeaseTravelOverride[];
  readonly status: "ready" | "invalid-input" | "limit-exceeded" | "unavailable";
  readonly transitions: readonly ContractTransitionRequest[];
}
