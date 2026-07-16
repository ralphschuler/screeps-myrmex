import { canonicalHash, deepFreeze } from "./canonical";
import {
  RUNTIME_CONFIG_SCHEMA_VERSION,
  type ObserverDiagnosticWindow,
  type RuntimeConfig,
} from "./contracts";
import {
  DEFAULT_CONFIGURED_RELATIONS,
  DEFAULT_SURVIVAL_POLICY,
  RUNTIME_CONFIG_SOURCE_REVISION,
} from "./defaults";
import { resolveFeatureGates } from "./gates";
import { mergePolicy, mergeRelations, type CanonicalRuntimeOverrides } from "./validation";

export function buildRuntimeConfig(
  overrides: CanonicalRuntimeOverrides = {},
  diagnosticExpiresAtTick: number | null = null,
  tick = 0,
): RuntimeConfig {
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
    observerDiagnostic: overrides.observer?.diagnostic ?? null,
  };
  const diagnostic = resolveDiagnostic(overrides, diagnosticExpiresAtTick, tick);

  return deepFreeze({
    schemaVersion: content.schemaVersion,
    sourceRevision: content.sourceRevision,
    revision: canonicalHash(content),
    policyRevision,
    policy: content.policy,
    relations: content.relations,
    features: content.features,
    observer: { diagnostic },
  });
}

export const SOURCE_DEFAULT_RUNTIME_CONFIG = buildRuntimeConfig();

function resolveDiagnostic(
  overrides: CanonicalRuntimeOverrides,
  expiresAtTick: number | null,
  tick: number,
): ObserverDiagnosticWindow | null {
  const diagnostic = overrides.observer?.diagnostic;
  if (diagnostic === undefined || expiresAtTick === null || tick >= expiresAtTick) return null;
  return {
    level: diagnostic.level,
    categories: diagnostic.categories,
    expiresAtTick,
  };
}
