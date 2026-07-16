import { compareStrings, deepFreeze } from "./canonical";
import {
  FEATURE_GATE_IDS,
  type FeatureGateDecision,
  type FeatureGateId,
  type RuntimeConfig,
  type RuntimeFeatureGates,
} from "./contracts";

export interface FeatureGateDefinition {
  readonly id: FeatureGateId;
  readonly available: boolean;
  readonly prerequisites: readonly FeatureGateId[];
}

/** Source availability is advanced only with a complete, tested gameplay slice. */
export const SOURCE_FEATURE_GATES: readonly FeatureGateDefinition[] = deepFreeze([
  { id: "phase1.colony", available: true, prerequisites: [] },
  { id: "phase1.contracts", available: true, prerequisites: ["phase1.colony"] },
  { id: "phase1.spawn", available: true, prerequisites: ["phase1.colony"] },
  { id: "phase1.movement", available: true, prerequisites: [] },
  {
    id: "phase1.agents",
    available: true,
    prerequisites: ["phase1.colony", "phase1.contracts", "phase1.movement"],
  },
  {
    id: "phase1.economy",
    available: true,
    prerequisites: ["phase1.agents", "phase1.spawn"],
  },
  { id: "phase1.recovery", available: true, prerequisites: ["phase1.economy"] },
  { id: "phase1.growth", available: false, prerequisites: ["phase1.recovery"] },
  {
    id: "phase1.safety",
    available: true,
    prerequisites: ["phase1.colony", "phase1.movement"],
  },
  {
    id: "phase1.telemetry",
    available: false,
    prerequisites: ["phase1.agents", "phase1.spawn"],
  },
  {
    id: "phase1.critical-maintenance",
    available: false,
    prerequisites: ["phase1.economy", "phase1.recovery"],
  },
]);

export function resolveFeatureGates(
  disabledInput: readonly FeatureGateId[],
  definitions: readonly FeatureGateDefinition[] = SOURCE_FEATURE_GATES,
): RuntimeFeatureGates {
  assertValidManifest(definitions);
  const disabled = [...disabledInput].sort(compareStrings);
  const disabledSet = new Set<FeatureGateId>(disabled);
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const decisions = new Map<FeatureGateId, FeatureGateDecision>();

  const resolve = (id: FeatureGateId): FeatureGateDecision => {
    const existing = decisions.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const definition = definitionsById.get(id);
    if (definition === undefined) {
      throw new TypeError(`Feature gate manifest is missing ${id}`);
    }

    let decision: FeatureGateDecision;
    if (!definition.available) {
      decision = { blockedBy: null, enabled: false, reason: "source-unavailable" };
    } else if (disabledSet.has(id)) {
      decision = { blockedBy: null, enabled: false, reason: "operator-disabled" };
    } else {
      const blockedBy = definition.prerequisites.find(
        (prerequisite) => !resolve(prerequisite).enabled,
      );
      decision =
        blockedBy === undefined
          ? { blockedBy: null, enabled: true, reason: "enabled" }
          : { blockedBy, enabled: false, reason: "prerequisite-blocked" };
    }
    decisions.set(id, decision);
    return decision;
  };

  const gates = Object.fromEntries(FEATURE_GATE_IDS.map((id) => [id, resolve(id)])) as Record<
    FeatureGateId,
    FeatureGateDecision
  >;
  return { disabled, gates };
}

export function isFeatureEnabled(config: RuntimeConfig, id: FeatureGateId): boolean {
  return config.features.gates[id].enabled;
}

function assertValidManifest(definitions: readonly FeatureGateDefinition[]): void {
  const byId = new Map<FeatureGateId, FeatureGateDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new TypeError(`Feature gate manifest duplicates ${definition.id}`);
    }
    byId.set(definition.id, definition);
  }
  if (byId.size !== FEATURE_GATE_IDS.length || FEATURE_GATE_IDS.some((id) => !byId.has(id))) {
    throw new TypeError("Feature gate manifest must define every gate exactly once");
  }

  const visiting = new Set<FeatureGateId>();
  const visited = new Set<FeatureGateId>();
  const visit = (id: FeatureGateId): void => {
    if (visiting.has(id)) {
      throw new TypeError("Feature gate manifest contains a prerequisite cycle");
    }
    if (visited.has(id)) {
      return;
    }
    const definition = byId.get(id);
    if (definition === undefined) {
      throw new TypeError(`Feature gate manifest references unknown ${id}`);
    }
    visiting.add(id);
    for (const prerequisite of definition.prerequisites) {
      if (!byId.has(prerequisite)) {
        throw new TypeError(`Feature gate manifest references unknown ${prerequisite}`);
      }
      visit(prerequisite);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of FEATURE_GATE_IDS) {
    visit(id);
  }
}
