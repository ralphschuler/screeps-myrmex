export {
  FEATURE_GATE_IDS,
  PLAYER_RELATIONS,
  RUNTIME_CONFIG_SCHEMA_VERSION,
  TARGETING_CEILINGS,
} from "./contracts";
export type {
  ConfiguredRelations,
  CriticalRepairPolicy,
  FeatureGateDecision,
  FeatureGateId,
  FeatureGateReason,
  LeasePolicy,
  MovementPolicy,
  PlayerRelation,
  RecoveryPolicy,
  RelationDecision,
  RelationDecisionReason,
  RelationDecisionRequest,
  ReputationStatus,
  RetryPolicy,
  RuntimeConfig,
  RuntimeFeatureGates,
  SafeModePolicy,
  SpawnPolicy,
  SurvivalPolicy,
  TargetingCeiling,
  TowerPolicy,
} from "./contracts";
export type {
  RuntimeConfigResolutionMetadata,
  RuntimeConfigResolutionReason,
  RuntimeConfigResolutionStatus,
} from "./authority-contracts";
export { isFeatureEnabled } from "./gates";
export { classifyPlayerRelation } from "./relations";
