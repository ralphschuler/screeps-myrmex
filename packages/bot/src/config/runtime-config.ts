import { canonicalHash, deepFreeze } from "./canonical";
import { RUNTIME_CONFIG_SCHEMA_VERSION, type RuntimeConfig } from "./contracts";
import {
  DEFAULT_CONFIGURED_RELATIONS,
  DEFAULT_SURVIVAL_POLICY,
  RUNTIME_CONFIG_SOURCE_REVISION,
} from "./defaults";
import { resolveFeatureGates } from "./gates";
import { mergePolicy, mergeRelations, type CanonicalRuntimeOverrides } from "./validation";

export function buildRuntimeConfig(overrides: CanonicalRuntimeOverrides = {}): RuntimeConfig {
  const policy = mergePolicy(DEFAULT_SURVIVAL_POLICY, overrides.policy);
  const relations = mergeRelations(DEFAULT_CONFIGURED_RELATIONS, overrides.relations);
  const features = resolveFeatureGates(overrides.features?.disabled ?? []);
  const policyRevision = canonicalHash(policy);
  const content = {
    schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
    sourceRevision: RUNTIME_CONFIG_SOURCE_REVISION,
    policy,
    relations,
    features,
  };

  return deepFreeze({
    schemaVersion: content.schemaVersion,
    sourceRevision: content.sourceRevision,
    revision: canonicalHash(content),
    policyRevision,
    policy: content.policy,
    relations: content.relations,
    features: content.features,
  });
}

export const SOURCE_DEFAULT_RUNTIME_CONFIG = buildRuntimeConfig();
