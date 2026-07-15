import { deepFreeze } from "./canonical";
import {
  PLAYER_RELATIONS,
  type PlayerRelation,
  type RelationDecision,
  type RelationDecisionReason,
  type RelationDecisionRequest,
  type ReputationStatus,
  type RuntimeConfig,
  type TargetingCeiling,
} from "./contracts";
import { isCanonicalIdentity } from "./identity";

const REPUTATION_SCHEMA_VERSION = 1;
const MAX_REPUTATION_AGE_TICKS = 1_500;

interface ReputationAssessment {
  readonly schemaVersion: typeof REPUTATION_SCHEMA_VERSION;
  readonly relation: PlayerRelation;
  readonly assessedAt: number;
  readonly expiresAt: number;
}

type ReputationRead =
  | { readonly status: "absent" | "stale" | "invalid"; readonly assessment: null }
  | { readonly status: "fresh"; readonly assessment: ReputationAssessment };

export function classifyPlayerRelation(
  config: RuntimeConfig,
  request: RelationDecisionRequest,
): RelationDecision {
  if (!isCanonicalIdentity(request.username)) {
    return decision(config, "neutral", "excluded", "invalid-observed-identity", "not-consulted");
  }
  const username = request.username;
  if (config.relations.self.includes(username)) {
    return decision(config, "self", "excluded", "configured-self", "not-consulted");
  }
  if (config.relations.allies.includes(username)) {
    return decision(config, "ally", "excluded", "configured-ally", "not-consulted");
  }
  if (config.relations.naps.includes(username)) {
    return decision(config, "nap", "excluded", "configured-nap", "not-consulted");
  }

  const reputation = readReputation(request.reputation, request.tick);
  if (reputation.status !== "fresh") {
    const reason: RelationDecisionReason =
      reputation.status === "absent"
        ? "reputation-absent"
        : reputation.status === "stale"
          ? "reputation-stale"
          : "reputation-invalid";
    return decision(config, "neutral", "local-defense", reason, reputation.status);
  }

  const relation = reputation.assessment.relation;
  return relation === "self" || relation === "ally" || relation === "nap"
    ? decision(config, relation, "excluded", "reputation-exclusion", "fresh")
    : decision(config, relation, "local-defense", "reputation-advisory", "fresh");
}

function readReputation(value: unknown, tick: number): ReputationRead {
  if (value === null || value === undefined) {
    return { status: "absent", assessment: null };
  }
  if (!Number.isSafeInteger(tick) || tick < 0 || Object.is(tick, -0)) {
    return { status: "invalid", assessment: null };
  }
  const record = exactDataRecord(value, ["schemaVersion", "relation", "assessedAt", "expiresAt"]);
  if (
    record === null ||
    record.schemaVersion !== REPUTATION_SCHEMA_VERSION ||
    typeof record.relation !== "string" ||
    !PLAYER_RELATIONS.includes(record.relation as PlayerRelation) ||
    !isNonNegativeSafeInteger(record.assessedAt) ||
    !isNonNegativeSafeInteger(record.expiresAt) ||
    record.assessedAt > tick ||
    record.expiresAt < record.assessedAt ||
    record.expiresAt - record.assessedAt > MAX_REPUTATION_AGE_TICKS
  ) {
    return { status: "invalid", assessment: null };
  }
  if (record.expiresAt < tick || tick - record.assessedAt > MAX_REPUTATION_AGE_TICKS) {
    return { status: "stale", assessment: null };
  }
  return {
    status: "fresh",
    assessment: {
      schemaVersion: REPUTATION_SCHEMA_VERSION,
      relation: record.relation as PlayerRelation,
      assessedAt: record.assessedAt,
      expiresAt: record.expiresAt,
    },
  };
}

function decision(
  config: RuntimeConfig,
  relation: PlayerRelation,
  targetingCeiling: TargetingCeiling,
  reasonCode: RelationDecisionReason,
  reputationStatus: ReputationStatus,
): RelationDecision {
  return deepFreeze({
    relation,
    targetingCeiling,
    reasonCode,
    reputationStatus,
    configRevision: config.revision,
    policyRevision: config.policyRevision,
  });
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return null;
    }
  }
  return value as Record<string, unknown>;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}
