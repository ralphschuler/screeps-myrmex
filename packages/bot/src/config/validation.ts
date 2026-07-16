import { compareStrings } from "./canonical";
import type {
  ConfiguredRelations,
  CriticalRepairPolicy,
  FeatureGateId,
  GrowthPolicy,
  LeasePolicy,
  MovementPolicy,
  ObserverDiagnosticCategory,
  ObserverDiagnosticLevel,
  RecoveryPolicy,
  RetryPolicy,
  SafeModePolicy,
  SpawnPolicy,
  SurvivalPolicy,
  TelemetryPolicy,
  TowerPolicy,
} from "./contracts";
import { FEATURE_GATE_IDS, OBSERVER_DIAGNOSTIC_CATEGORIES } from "./contracts";
import { DEFAULT_SURVIVAL_POLICY } from "./defaults";
import { isCanonicalIdentity } from "./identity";

export const MAX_CONFIG_OVERRIDE_DEPTH = 5;
export const MAX_CONFIG_OVERRIDE_KEYS = 64;
export const MAX_CONFIG_OVERRIDE_NODES = 256;
export const MAX_CONFIG_OVERRIDE_UTF8_BYTES = 8_192;
export const MAX_CONFIG_OVERRIDE_ARRAY_ITEMS = 32;
export const MAX_CONFIG_OVERRIDE_KEY_CODE_UNITS = 64;
export const MAX_CONFIG_IDENTITIES_PER_CLASS = 32;
export const MAX_CONFIG_IDENTITIES_TOTAL = 64;

export type ConfigValidationReason =
  | "budget-exceeded"
  | "shape"
  | "unknown-key"
  | "type"
  | "range"
  | "identity"
  | "identity-overlap"
  | "gate-id"
  | "invariant";

export interface RuntimePolicyOverrides {
  readonly recovery?: Partial<RecoveryPolicy>;
  readonly leases?: Partial<LeasePolicy>;
  readonly retries?: Partial<RetryPolicy>;
  readonly movement?: Partial<MovementPolicy>;
  readonly spawn?: Partial<SpawnPolicy>;
  readonly repair?: Partial<CriticalRepairPolicy>;
  readonly growth?: Partial<GrowthPolicy>;
  readonly telemetry?: Partial<TelemetryPolicy>;
  readonly tower?: Partial<TowerPolicy>;
  readonly safeMode?: Partial<SafeModePolicy>;
}

export interface RuntimeRelationOverrides {
  readonly self?: readonly string[];
  readonly allies?: readonly string[];
  readonly naps?: readonly string[];
}

export interface RuntimeFeatureOverrides {
  readonly disabled?: readonly FeatureGateId[];
}

export interface ObserverDiagnosticOverride {
  readonly level: ObserverDiagnosticLevel;
  readonly categories: readonly ObserverDiagnosticCategory[];
  readonly durationTicks: number;
}

export interface RuntimeObserverOverrides {
  readonly diagnostic?: ObserverDiagnosticOverride;
}

export interface CanonicalRuntimeOverrides {
  readonly policy?: RuntimePolicyOverrides;
  readonly relations?: RuntimeRelationOverrides;
  readonly features?: RuntimeFeatureOverrides;
  readonly observer?: RuntimeObserverOverrides;
}

export type RuntimeOverrideValidation =
  | {
      readonly valid: true;
      readonly overrides: CanonicalRuntimeOverrides;
      readonly inputCanonical: string;
    }
  | {
      readonly valid: false;
      readonly reason: ConfigValidationReason;
      readonly inputCanonical: string | null;
    };

interface ValidationSuccess<Value> {
  readonly valid: true;
  readonly value: Value;
}

interface ValidationFailure {
  readonly valid: false;
  readonly reason: ConfigValidationReason;
}

type ValidationResult<Value> = ValidationSuccess<Value> | ValidationFailure;

interface ValidationBudget {
  nodes: number;
  keys: number;
  bytes: number;
}

interface NumberFieldSpec {
  readonly minimum: number;
  readonly maximum: number;
}

const RECOVERY_FIELDS = {
  protectedSpawnEnergy: { minimum: 200, maximum: 12_900 },
  emergencyWorkerEnergyBudget: { minimum: 200, maximum: 800 },
  controllerRiskWindowTicks: { minimum: 500, maximum: 20_000 },
} as const satisfies Readonly<Record<keyof RecoveryPolicy, NumberFieldSpec>>;

const LEASE_FIELDS = {
  durationTicks: { minimum: 1, maximum: 1_500 },
  renewalWindowTicks: { minimum: 0, maximum: 1_499 },
} as const satisfies Readonly<Record<keyof LeasePolicy, NumberFieldSpec>>;

const RETRY_FIELDS = {
  maximumAttempts: { minimum: 0, maximum: 16 },
  initialDelayTicks: { minimum: 1, maximum: 100 },
  maximumDelayTicks: { minimum: 1, maximum: 1_500 },
} as const satisfies Readonly<Record<keyof RetryPolicy, NumberFieldSpec>>;

const MOVEMENT_FIELDS = {
  maximumSearchOperations: { minimum: 100, maximum: 10_000 },
  maximumPathCost: { minimum: 10, maximum: 1_000 },
  stuckReplanTicks: { minimum: 1, maximum: 20 },
  blockedReleaseTicks: { minimum: 1, maximum: 100 },
} as const satisfies Readonly<Record<keyof MovementPolicy, NumberFieldSpec>>;

const SPAWN_FIELDS = {
  maximumBodyParts: { minimum: 3, maximum: 50 },
  maximumBodyEnergy: { minimum: 200, maximum: 12_900 },
  maximumNonMovePartsPerMovePart: { minimum: 1, maximum: 5 },
  replacementSafetyMarginTicks: { minimum: 0, maximum: 300 },
  nameCollisionRetryLimit: { minimum: 1, maximum: 10 },
} as const satisfies Readonly<Record<keyof SpawnPolicy, NumberFieldSpec>>;

const REPAIR_FIELDS = {
  criticalHitsBasisPoints: { minimum: 1, maximum: 5_000 },
  completionHitsBasisPoints: { minimum: 1, maximum: 10_000 },
  maximumActiveContractsPerRoom: { minimum: 1, maximum: 16 },
  maximumEnergyPerTick: { minimum: 1, maximum: 1_000 },
} as const satisfies Readonly<Record<keyof CriticalRepairPolicy, NumberFieldSpec>>;

const GROWTH_FIELDS = {
  minimumSurplusEnergy: { minimum: 0, maximum: 12_900 },
  maximumActiveContractsPerRoom: { minimum: 1, maximum: 16 },
  maximumEnergyPerTick: { minimum: 1, maximum: 1_000 },
} as const satisfies Readonly<Record<keyof GrowthPolicy, NumberFieldSpec>>;

const TELEMETRY_FIELDS = {
  maximumDetailRecords: { minimum: 1, maximum: 256 },
  maximumHistoryEntries: { minimum: 0, maximum: 64 },
  maximumHistoryBytes: { minimum: 512, maximum: 32_768 },
} as const satisfies Readonly<Record<keyof TelemetryPolicy, NumberFieldSpec>>;

const TOWER_FIELDS = {
  emergencyReserveEnergy: { minimum: 0, maximum: 1_000 },
  repairMinimumEnergy: { minimum: 0, maximum: 1_000 },
} as const satisfies Readonly<Record<keyof TowerPolicy, NumberFieldSpec>>;

const SAFE_MODE_NUMBER_FIELDS = {
  criticalAssetHitsBasisPoints: { minimum: 1, maximum: 5_000 },
  lossPredictionHorizonTicks: { minimum: 1, maximum: 100 },
  minimumHostileOffenseParts: { minimum: 1, maximum: 50 },
  retryDelayTicks: { minimum: 1, maximum: 100 },
} as const satisfies Readonly<Record<Exclude<keyof SafeModePolicy, "enabled">, NumberFieldSpec>>;

export function validateRuntimeOverrides(value: unknown): RuntimeOverrideValidation {
  const inspected = inspectBoundedData(value);
  if (!inspected.valid) {
    return { valid: false, reason: inspected.reason, inputCanonical: null };
  }

  const parsed = parseRuntimeOverrides(value);
  if (!parsed.valid) {
    return { valid: false, reason: parsed.reason, inputCanonical: inspected.value };
  }
  if (!resolvedPolicySatisfiesInvariants(parsed.value.policy)) {
    return { valid: false, reason: "invariant", inputCanonical: inspected.value };
  }

  const canonical = inspectBoundedData(parsed.value);
  if (!canonical.valid) {
    return { valid: false, reason: canonical.reason, inputCanonical: null };
  }
  return { valid: true, overrides: parsed.value, inputCanonical: canonical.value };
}

function inspectBoundedData(value: unknown): ValidationResult<string> {
  const budget: ValidationBudget = { nodes: 0, keys: 0, bytes: 0 };
  return inspectData(value, 0, new Set<object>(), budget);
}

function inspectData(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  budget: ValidationBudget,
): ValidationResult<string> {
  budget.nodes += 1;
  if (budget.nodes > MAX_CONFIG_OVERRIDE_NODES || depth > MAX_CONFIG_OVERRIDE_DEPTH) {
    return invalid("budget-exceeded");
  }

  if (value === null) {
    return serialized("null", budget);
  }
  if (typeof value === "boolean") {
    return serialized(value ? "true" : "false", budget);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      return invalid("type");
    }
    return serialized(String(value), budget);
  }
  if (typeof value === "string") {
    return serializedString(value, budget);
  }
  if (typeof value !== "object") {
    return invalid("type");
  }
  if (ancestors.has(value)) {
    return invalid("shape");
  }

  ancestors.add(value);
  const result = Array.isArray(value)
    ? inspectArray(value, depth, ancestors, budget)
    : inspectObject(value, depth, ancestors, budget);
  ancestors.delete(value);
  return result;
}

function inspectArray(
  value: readonly unknown[],
  depth: number,
  ancestors: Set<object>,
  budget: ValidationBudget,
): ValidationResult<string> {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_CONFIG_OVERRIDE_ARRAY_ITEMS
  ) {
    return invalid(value.length > MAX_CONFIG_OVERRIDE_ARRAY_ITEMS ? "budget-exceeded" : "shape");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol") || ownKeys.length !== value.length + 1) {
    return invalid("shape");
  }

  if (!addBytes(2 + Math.max(0, value.length - 1), budget)) {
    return invalid("budget-exceeded");
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid("shape");
    }
    const item = inspectData(descriptor.value, depth + 1, ancestors, budget);
    if (!item.valid) {
      return item;
    }
    items.push(item.value);
  }
  return valid(`[${items.join(",")}]`);
}

function inspectObject(
  value: object,
  depth: number,
  ancestors: Set<object>,
  budget: ValidationBudget,
): ValidationResult<string> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid("shape");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > MAX_CONFIG_OVERRIDE_KEYS - budget.keys) {
    return invalid("budget-exceeded");
  }
  const keys: string[] = [];
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      return invalid("shape");
    }
    if (key.length > MAX_CONFIG_OVERRIDE_KEY_CODE_UNITS) {
      return invalid("budget-exceeded");
    }
    keys.push(key);
  }
  budget.keys += keys.length;
  keys.sort(compareStrings);

  if (!addBytes(2 + Math.max(0, keys.length - 1), budget)) {
    return invalid("budget-exceeded");
  }
  const entries: string[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid("shape");
    }
    const encodedKey = serializedString(key, budget);
    if (!encodedKey.valid || !addBytes(1, budget)) {
      return invalid("budget-exceeded");
    }
    const item = inspectData(descriptor.value, depth + 1, ancestors, budget);
    if (!item.valid) {
      return item;
    }
    entries.push(`${encodedKey.value}:${item.value}`);
  }
  return valid(`{${entries.join(",")}}`);
}

function serialized(value: string, budget: ValidationBudget): ValidationResult<string> {
  return addBytes(value.length, budget) ? valid(value) : invalid("budget-exceeded");
}

/**
 * Encodes one JSON string while charging each fragment before retaining it. Unlike JSON.stringify,
 * this stops at the remaining config budget instead of allocating or scanning an oversized input.
 */
function serializedString(value: string, budget: ValidationBudget): ValidationResult<string> {
  const fragments: string[] = [];
  if (!appendStringFragment('"', 1, fragments, budget)) {
    return invalid("budget-exceeded");
  }

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const escape = shortJsonEscape(codeUnit);
    if (escape !== null) {
      if (!appendStringFragment(escape, 2, fragments, budget)) {
        return invalid("budget-exceeded");
      }
      continue;
    }
    if (codeUnit <= 0x1f) {
      if (
        !appendStringFragment(`\\u${codeUnit.toString(16).padStart(4, "0")}`, 6, fragments, budget)
      ) {
        return invalid("budget-exceeded");
      }
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (!appendStringFragment(value.slice(index, index + 2), 4, fragments, budget)) {
          return invalid("budget-exceeded");
        }
        index += 1;
      } else if (!appendUnicodeEscape(codeUnit, fragments, budget)) {
        return invalid("budget-exceeded");
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      if (!appendUnicodeEscape(codeUnit, fragments, budget)) {
        return invalid("budget-exceeded");
      }
      continue;
    }

    const bytes = codeUnit < 0x80 ? 1 : codeUnit < 0x800 ? 2 : 3;
    if (!appendStringFragment(value[index] ?? "", bytes, fragments, budget)) {
      return invalid("budget-exceeded");
    }
  }

  if (!appendStringFragment('"', 1, fragments, budget)) {
    return invalid("budget-exceeded");
  }
  return valid(fragments.join(""));
}

function shortJsonEscape(codeUnit: number): string | null {
  switch (codeUnit) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    case 0x22:
      return '\\"';
    case 0x5c:
      return "\\\\";
    default:
      return null;
  }
}

function appendUnicodeEscape(
  codeUnit: number,
  fragments: string[],
  budget: ValidationBudget,
): boolean {
  return appendStringFragment(`\\u${codeUnit.toString(16).padStart(4, "0")}`, 6, fragments, budget);
}

function appendStringFragment(
  fragment: string,
  bytes: number,
  fragments: string[],
  budget: ValidationBudget,
): boolean {
  if (!addBytes(bytes, budget)) {
    return false;
  }
  fragments.push(fragment);
  return true;
}

function addBytes(count: number, budget: ValidationBudget): boolean {
  budget.bytes += count;
  return budget.bytes <= MAX_CONFIG_OVERRIDE_UTF8_BYTES;
}

function parseRuntimeOverrides(value: unknown): ValidationResult<CanonicalRuntimeOverrides> {
  const root = exactRecord(value, ["policy", "relations", "features", "observer"]);
  if (!root.valid) {
    return root;
  }

  const result: {
    policy?: RuntimePolicyOverrides;
    relations?: RuntimeRelationOverrides;
    features?: RuntimeFeatureOverrides;
    observer?: RuntimeObserverOverrides;
  } = {};
  if (has(root.value, "policy")) {
    const policy = parsePolicyOverrides(root.value.policy);
    if (!policy.valid) {
      return policy;
    }
    result.policy = policy.value;
  }
  if (has(root.value, "relations")) {
    const relations = parseRelationOverrides(root.value.relations);
    if (!relations.valid) {
      return relations;
    }
    result.relations = relations.value;
  }
  if (has(root.value, "features")) {
    const features = parseFeatureOverrides(root.value.features);
    if (!features.valid) {
      return features;
    }
    result.features = features.value;
  }
  if (has(root.value, "observer")) {
    const observer = parseObserverOverrides(root.value.observer);
    if (!observer.valid) {
      return observer;
    }
    result.observer = observer.value;
  }
  return valid(result);
}

function parseObserverOverrides(value: unknown): ValidationResult<RuntimeObserverOverrides> {
  const root = exactRecord(value, ["diagnostic"]);
  if (!root.valid) return root;
  if (!has(root.value, "diagnostic")) return valid({});
  const diagnostic = exactRecord(root.value.diagnostic, ["level", "categories", "durationTicks"]);
  if (!diagnostic.valid) return diagnostic;
  if (diagnostic.value.level !== "debug" && diagnostic.value.level !== "trace")
    return invalid("type");
  if (
    typeof diagnostic.value.durationTicks !== "number" ||
    !Number.isSafeInteger(diagnostic.value.durationTicks)
  )
    return invalid("type");
  if (
    diagnostic.value.durationTicks < 1 ||
    diagnostic.value.durationTicks > DEFAULT_SURVIVAL_POLICY.reporter.maximumDiagnosticDurationTicks
  )
    return invalid("range");
  if (!Array.isArray(diagnostic.value.categories)) return invalid("type");
  const allowed = new Set<string>(OBSERVER_DIAGNOSTIC_CATEGORIES);
  const categories: ObserverDiagnosticCategory[] = [];
  const seen = new Set<ObserverDiagnosticCategory>();
  for (const category of diagnostic.value.categories) {
    if (
      typeof category !== "string" ||
      !allowed.has(category) ||
      seen.has(category as ObserverDiagnosticCategory)
    )
      return invalid("type");
    seen.add(category as ObserverDiagnosticCategory);
    categories.push(category as ObserverDiagnosticCategory);
  }
  if (categories.length === 0) return invalid("range");
  return valid({
    diagnostic: {
      level: diagnostic.value.level,
      categories: categories.sort(compareStrings),
      durationTicks: diagnostic.value.durationTicks,
    },
  });
}

function parsePolicyOverrides(value: unknown): ValidationResult<RuntimePolicyOverrides> {
  const root = exactRecord(value, [
    "recovery",
    "leases",
    "retries",
    "movement",
    "spawn",
    "repair",
    "growth",
    "telemetry",
    "tower",
    "safeMode",
  ]);
  if (!root.valid) {
    return root;
  }
  const output: Record<string, unknown> = {};
  const groups: readonly [string, Readonly<Record<string, NumberFieldSpec>>][] = [
    ["recovery", RECOVERY_FIELDS],
    ["leases", LEASE_FIELDS],
    ["retries", RETRY_FIELDS],
    ["movement", MOVEMENT_FIELDS],
    ["spawn", SPAWN_FIELDS],
    ["repair", REPAIR_FIELDS],
    ["growth", GROWTH_FIELDS],
    ["telemetry", TELEMETRY_FIELDS],
    ["tower", TOWER_FIELDS],
  ];
  for (const [name, fields] of groups) {
    if (!has(root.value, name)) {
      continue;
    }
    const group = parseNumberGroup(root.value[name], fields);
    if (!group.valid) {
      return group;
    }
    output[name] = group.value;
  }
  if (has(root.value, "safeMode")) {
    const safeMode = parseSafeModeOverrides(root.value.safeMode);
    if (!safeMode.valid) {
      return safeMode;
    }
    output.safeMode = safeMode.value;
  }
  return valid(output as RuntimePolicyOverrides);
}

function parseNumberGroup(
  value: unknown,
  specifications: Readonly<Record<string, NumberFieldSpec>>,
): ValidationResult<Record<string, number>> {
  const root = exactRecord(value, Object.keys(specifications));
  if (!root.valid) {
    return root;
  }
  const output: Record<string, number> = {};
  for (const [name, specification] of Object.entries(specifications)) {
    if (!has(root.value, name)) {
      continue;
    }
    const candidate = root.value[name];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
      return invalid("type");
    }
    if (candidate < specification.minimum || candidate > specification.maximum) {
      return invalid("range");
    }
    output[name] = candidate;
  }
  return valid(output);
}

function parseSafeModeOverrides(value: unknown): ValidationResult<Partial<SafeModePolicy>> {
  const root = exactRecord(value, ["enabled", ...Object.keys(SAFE_MODE_NUMBER_FIELDS)]);
  if (!root.valid) {
    return root;
  }
  const output: Record<string, boolean | number> = {};
  if (has(root.value, "enabled")) {
    if (typeof root.value.enabled !== "boolean") {
      return invalid("type");
    }
    output.enabled = root.value.enabled;
  }
  for (const [name, specification] of Object.entries(SAFE_MODE_NUMBER_FIELDS)) {
    if (!has(root.value, name)) {
      continue;
    }
    const candidate = root.value[name];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
      return invalid("type");
    }
    if (candidate < specification.minimum || candidate > specification.maximum) {
      return invalid("range");
    }
    output[name] = candidate;
  }
  return valid(output as Partial<SafeModePolicy>);
}

function parseRelationOverrides(value: unknown): ValidationResult<RuntimeRelationOverrides> {
  const root = exactRecord(value, ["self", "allies", "naps"]);
  if (!root.valid) {
    return root;
  }
  const output: { self?: readonly string[]; allies?: readonly string[]; naps?: readonly string[] } =
    {};
  let total = 0;
  const all = new Set<string>();
  for (const name of ["self", "allies", "naps"] as const) {
    if (!has(root.value, name)) {
      continue;
    }
    const parsed = parseIdentities(root.value[name]);
    if (!parsed.valid) {
      return parsed;
    }
    total += parsed.value.length;
    if (total > MAX_CONFIG_IDENTITIES_TOTAL) {
      return invalid("identity");
    }
    for (const identity of parsed.value) {
      if (all.has(identity)) {
        return invalid("identity-overlap");
      }
      all.add(identity);
    }
    output[name] = parsed.value;
  }
  return valid(output);
}

function parseIdentities(value: unknown): ValidationResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_IDENTITIES_PER_CLASS) {
    return invalid("identity");
  }
  const identities: string[] = [];
  const seen = new Set<string>();
  for (const identity of value) {
    if (!isCanonicalIdentity(identity) || seen.has(identity)) {
      return invalid("identity");
    }
    seen.add(identity);
    identities.push(identity);
  }
  return valid(identities.sort(compareStrings));
}

function parseFeatureOverrides(value: unknown): ValidationResult<RuntimeFeatureOverrides> {
  const root = exactRecord(value, ["disabled"]);
  if (!root.valid) {
    return root;
  }
  if (!has(root.value, "disabled")) {
    return valid({});
  }
  if (!Array.isArray(root.value.disabled)) {
    return invalid("type");
  }
  const known = new Set<string>(FEATURE_GATE_IDS);
  const seen = new Set<FeatureGateId>();
  const disabled: FeatureGateId[] = [];
  for (const id of root.value.disabled) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id as FeatureGateId)) {
      return invalid("gate-id");
    }
    seen.add(id as FeatureGateId);
    disabled.push(id as FeatureGateId);
  }
  return valid({ disabled: disabled.sort(compareStrings) });
}

function resolvedPolicySatisfiesInvariants(overrides: RuntimePolicyOverrides | undefined): boolean {
  const policy = mergePolicy(DEFAULT_SURVIVAL_POLICY, overrides);
  return (
    policy.recovery.emergencyWorkerEnergyBudget <= policy.recovery.protectedSpawnEnergy &&
    policy.recovery.emergencyWorkerEnergyBudget <= policy.spawn.maximumBodyEnergy &&
    policy.leases.renewalWindowTicks < policy.leases.durationTicks &&
    policy.retries.initialDelayTicks <= policy.retries.maximumDelayTicks &&
    policy.movement.stuckReplanTicks <= policy.movement.blockedReleaseTicks &&
    policy.repair.criticalHitsBasisPoints <= policy.repair.completionHitsBasisPoints &&
    policy.tower.emergencyReserveEnergy <= policy.tower.repairMinimumEnergy &&
    policy.reporter.initialReminderDelayTicks <= policy.reporter.maximumReminderDelayTicks
  );
}

export function mergePolicy(
  defaults: SurvivalPolicy,
  overrides: RuntimePolicyOverrides | undefined,
): SurvivalPolicy {
  return {
    recovery: { ...defaults.recovery, ...overrides?.recovery },
    leases: { ...defaults.leases, ...overrides?.leases },
    retries: { ...defaults.retries, ...overrides?.retries },
    movement: { ...defaults.movement, ...overrides?.movement },
    spawn: { ...defaults.spawn, ...overrides?.spawn },
    repair: { ...defaults.repair, ...overrides?.repair },
    growth: { ...defaults.growth, ...overrides?.growth },
    telemetry: { ...defaults.telemetry, ...overrides?.telemetry },
    reporter: defaults.reporter,
    tower: { ...defaults.tower, ...overrides?.tower },
    safeMode: { ...defaults.safeMode, ...overrides?.safeMode },
  };
}

export function mergeRelations(
  defaults: ConfiguredRelations,
  overrides: RuntimeRelationOverrides | undefined,
): ConfiguredRelations {
  return {
    self: overrides?.self ?? defaults.self,
    allies: overrides?.allies ?? defaults.allies,
    naps: overrides?.naps ?? defaults.naps,
  };
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): ValidationResult<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("shape");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedKeys.includes(key))) {
    return invalid("unknown-key");
  }
  return valid(value as Record<string, unknown>);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function valid<Value>(value: Value): ValidationSuccess<Value> {
  return { valid: true, value };
}

function invalid(reason: ConfigValidationReason): ValidationFailure {
  return { valid: false, reason };
}
