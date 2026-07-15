import {
  LEGACY_MEMORY_MIGRATION_ID,
  LEGACY_MEMORY_MIGRATION_STEP_COUNT,
  LEGACY_MEMORY_SCHEMA_VERSION,
  MEMORY_CURRENT_SCHEMA_VERSION,
  MEMORY_MIGRATION_ID,
  MEMORY_MIGRATION_STEP_COUNT,
  MEMORY_TARGET_SCHEMA_VERSION,
  MAX_MEMORY_DIAGNOSTICS,
  PERSISTENT_STATE_OWNERS,
  PREVIOUS_MEMORY_SCHEMA_VERSION,
  PREVIOUS_PERSISTENT_STATE_OWNERS,
  type JsonObject,
  type MemoryMigrationCursor,
  type MigratingMyrmexMemory,
  type MyrmexMemory,
  type OwnerStateView,
  type PersistentStateOwner,
  type PreviousMyrmexMemory,
  type StateView,
} from "./schema";
import { projectMigrationFinalState } from "./migration-projection";

const MAX_JSON_DEPTH = 64;
export const MAX_PERSISTENT_JSON_NODES = 50_000;
export const MAX_PERSISTENT_JSON_CODE_UNITS = 1_500_000;
export const MAX_PERSISTENT_ARRAY_LENGTH = 10_000;
export const MAX_PERSISTENT_OBJECT_KEYS = 10_000;
export const MAX_PERSISTENT_KEY_LENGTH = 1_024;

/**
 * A valid migration cursor replaces two final nulls with fixed migration/recovery records: at most
 * 11 extra nodes and 136 extra key/string code units. Both migration IDs have 22 code units and the
 * same record shape. When the diagnostic ring is full, finalization can replace a 160-code-unit entry
 * with a 48-unit completion entry, making the exact worst-case transient delta 136 + 112 = 248 code
 * units. No owner payload receives this allowance: every accepted cursor must also project to a
 * selected final v3 root within the published caps.
 */
const MIGRATION_TRANSIENT_NODE_OVERHEAD = 11;
const MIGRATION_TRANSIENT_CODE_UNIT_OVERHEAD = 248;

export interface JsonValidationSuccess {
  readonly valid: true;
}

export interface JsonValidationFailure {
  readonly valid: false;
  readonly message: string;
  readonly path: string;
}

export type JsonValidationResult = JsonValidationSuccess | JsonValidationFailure;

interface JsonValidationBudget {
  codeUnits: number;
  maximumCodeUnits: number;
  maximumNodes: number;
  nodes: number;
}

const VALID_JSON: JsonValidationSuccess = { valid: true };

export function validateJsonValue(value: unknown): JsonValidationResult {
  return validateJsonWithLimits(value, MAX_PERSISTENT_JSON_NODES, MAX_PERSISTENT_JSON_CODE_UNITS);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value) && validateJsonValue(value).valid;
}

export function isCurrentMyrmexMemory(value: unknown): value is MyrmexMemory {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["meta", ...PERSISTENT_STATE_OWNERS])) {
    return false;
  }

  if (!isCurrentMeta(value.meta)) {
    return false;
  }

  return (
    PERSISTENT_STATE_OWNERS.every((owner) => isJsonObject(value[owner])) &&
    validateJsonValue(value).valid
  );
}

export function isPreviousMyrmexMemory(value: unknown): value is PreviousMyrmexMemory {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["meta", ...PREVIOUS_PERSISTENT_STATE_OWNERS])) {
    return false;
  }

  if (!isPreviousMeta(value.meta)) {
    return false;
  }

  return (
    PREVIOUS_PERSISTENT_STATE_OWNERS.every((owner) => isJsonObject(value[owner])) &&
    validateJsonValue(value).valid
  );
}

export function isMigratingMyrmexMemory(value: unknown): value is MigratingMyrmexMemory {
  if (!isPlainObject(value) || !isMigratingMeta(value.meta)) {
    return false;
  }

  const expectedOwners = expectedMigrationOwners(value.meta.migration);
  const allowedOwners = allowedMigrationOwners(value.meta.migration);
  const actualKeys = Object.keys(value);
  if (
    expectedOwners === null ||
    !actualKeys.every((key) => key === "meta" || allowedOwners.includes(key)) ||
    !expectedOwners.every((owner) => owner in value)
  ) {
    return false;
  }

  if (!actualKeys.filter((key) => key !== "meta").every((owner) => isJsonObject(value[owner]))) {
    return false;
  }

  const root = value as MigratingMyrmexMemory;
  const projected = selectMigrationFinalState(root, root.meta.lastTick);
  return (
    projected !== null &&
    validateJsonWithLimits(
      root,
      MAX_PERSISTENT_JSON_NODES + MIGRATION_TRANSIENT_NODE_OVERHEAD,
      MAX_PERSISTENT_JSON_CODE_UNITS + MIGRATION_TRANSIENT_CODE_UNIT_OVERHEAD,
    ).valid
  );
}

/** Selects the exact final root without ever evicting owner state for optional diagnostic evidence. */
export function selectMigrationFinalState(
  root: MigratingMyrmexMemory,
  tick: number,
): MyrmexMemory | null {
  const withCompletion = projectMigrationFinalState(root, tick, true);
  if (isCurrentMyrmexMemory(withCompletion)) {
    return withCompletion;
  }

  const withoutCompletion = projectMigrationFinalState(root, tick, false);
  return isCurrentMyrmexMemory(withoutCompletion) ? withoutCompletion : null;
}

export function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJson(value) as JsonObject;
}

export function readonlyOwnerView(value: JsonObject): OwnerStateView {
  return freezeJson(cloneJsonObject(value));
}

export function readonlyStateView(value: MyrmexMemory): StateView {
  const clone = cloneJson(value) as Record<string, unknown>;
  delete clone.config;
  delete clone.colonies;
  delete clone.contracts;
  return freezeJson(clone) as StateView;
}

export function cloneCurrentMemory(value: MyrmexMemory): MyrmexMemory {
  return cloneJson(value) as MyrmexMemory;
}

function validateJson(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
  budget: JsonValidationBudget,
): JsonValidationResult {
  budget.nodes += 1;
  if (budget.nodes > budget.maximumNodes) {
    return invalid(path, `JSON value exceeds ${String(budget.maximumNodes)} nodes`);
  }
  if (depth > MAX_JSON_DEPTH) {
    return invalid(path, `JSON nesting exceeds ${String(MAX_JSON_DEPTH)} levels`);
  }

  if (typeof value === "string") {
    budget.codeUnits += value.length;
    return budget.codeUnits <= budget.maximumCodeUnits
      ? VALID_JSON
      : invalid(path, `JSON strings and keys exceed ${String(budget.maximumCodeUnits)} code units`);
  }

  if (value === null || typeof value === "boolean") {
    return VALID_JSON;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? VALID_JSON : invalid(path, "number must be finite");
  }

  if (typeof value !== "object") {
    return invalid(path, `${typeof value} is not JSON serializable`);
  }

  if (ancestors.has(value)) {
    return invalid(path, "cyclic reference is not JSON serializable");
  }

  ancestors.add(value);
  let result: JsonValidationResult;

  if (Array.isArray(value)) {
    result = validateArray(value, path, depth, ancestors, budget);
  } else if (isPlainObject(value)) {
    result = validateObject(value, path, depth, ancestors, budget);
  } else {
    result = invalid(path, "only plain objects and arrays may be persisted");
  }

  ancestors.delete(value);
  return result;
}

function validateArray(
  value: readonly unknown[],
  path: string,
  depth: number,
  ancestors: Set<object>,
  budget: JsonValidationBudget,
): JsonValidationResult {
  if (value.length > MAX_PERSISTENT_ARRAY_LENGTH || Object.keys(value).length !== value.length) {
    return invalid(
      path,
      `arrays must be dense data with at most ${String(MAX_PERSISTENT_ARRAY_LENGTH)} items`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      return invalid(`${path}[${String(index)}]`, "sparse arrays are not allowed");
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid(`${path}[${String(index)}]`, "array items must be enumerable data properties");
    }
    const result = validateJson(
      descriptor.value,
      `${path}[${String(index)}]`,
      depth + 1,
      ancestors,
      budget,
    );
    if (!result.valid) {
      return result;
    }
  }

  return VALID_JSON;
}

function validateObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  ancestors: Set<object>,
  budget: JsonValidationBudget,
): JsonValidationResult {
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_PERSISTENT_OBJECT_KEYS || Reflect.ownKeys(value).length !== keys.length) {
    return invalid(
      path,
      `objects must contain at most ${String(MAX_PERSISTENT_OBJECT_KEYS)} enumerable string keys`,
    );
  }
  for (const key of keys) {
    if (key.length > MAX_PERSISTENT_KEY_LENGTH) {
      return invalid(appendPath(path, key), "object key exceeds the persistent key length limit");
    }
    budget.codeUnits += key.length;
    if (budget.codeUnits > budget.maximumCodeUnits) {
      return invalid(path, "JSON strings and keys exceed the persistent code-unit limit");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid(appendPath(path, key), "object fields must be enumerable data properties");
    }
    const result = validateJson(
      descriptor.value,
      appendPath(path, key),
      depth + 1,
      ancestors,
      budget,
    );
    if (!result.valid) {
      return result;
    }
  }

  return VALID_JSON;
}

function validateJsonWithLimits(
  value: unknown,
  maximumNodes: number,
  maximumCodeUnits: number,
): JsonValidationResult {
  return validateJson(value, "$", 0, new Set<object>(), {
    nodes: 0,
    codeUnits: 0,
    maximumNodes,
    maximumCodeUnits,
  });
}

function isCurrentMeta(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "targetSchemaVersion",
      "revision",
      "firstTick",
      "lastTick",
      "shard",
      "diagnostics",
      "migration",
      "recovery",
    ])
  ) {
    return false;
  }

  return (
    value.schemaVersion === MEMORY_CURRENT_SCHEMA_VERSION &&
    value.targetSchemaVersion === MEMORY_TARGET_SCHEMA_VERSION &&
    isNonNegativeInteger(value.revision) &&
    isNonNegativeInteger(value.firstTick) &&
    isNonNegativeInteger(value.lastTick) &&
    value.lastTick >= value.firstTick &&
    typeof value.shard === "string" &&
    value.shard.length > 0 &&
    isDiagnosticHistory(value.diagnostics) &&
    value.migration === null &&
    value.recovery === null
  );
}

function isPreviousMeta(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "targetSchemaVersion",
      "revision",
      "firstTick",
      "lastTick",
      "shard",
      "diagnostics",
      "migration",
      "recovery",
    ])
  ) {
    return false;
  }

  return (
    value.schemaVersion === PREVIOUS_MEMORY_SCHEMA_VERSION &&
    value.targetSchemaVersion === PREVIOUS_MEMORY_SCHEMA_VERSION &&
    isNonNegativeInteger(value.revision) &&
    isNonNegativeInteger(value.firstTick) &&
    isNonNegativeInteger(value.lastTick) &&
    value.lastTick >= value.firstTick &&
    typeof value.shard === "string" &&
    value.shard.length > 0 &&
    isDiagnosticHistory(value.diagnostics) &&
    value.migration === null &&
    value.recovery === null
  );
}

function isMigratingMeta(value: unknown): value is MigratingMyrmexMemory["meta"] {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "targetSchemaVersion",
      "revision",
      "firstTick",
      "lastTick",
      "shard",
      "diagnostics",
      "migration",
      "recovery",
    ]) ||
    !isPlainObject(value.migration) ||
    !isPlainObject(value.recovery)
  ) {
    return false;
  }

  const migration = value.migration;
  const recovery = value.recovery;

  if (!(
    isNonNegativeInteger(value.revision) &&
    isNonNegativeInteger(value.firstTick) &&
    isNonNegativeInteger(value.lastTick) &&
    value.lastTick >= value.firstTick &&
    typeof value.shard === "string" &&
    value.shard.length > 0 &&
    isDiagnosticHistory(value.diagnostics) &&
    hasOnlyKeys(migration, [
      "id",
      "fromVersion",
      "targetVersion",
      "nextStep",
      "stepCount",
      "startedAt",
      "updatedAt",
    ]) &&
    isNonNegativeInteger(migration.nextStep) &&
    isNonNegativeInteger(migration.startedAt) &&
    isNonNegativeInteger(migration.updatedAt) &&
    hasOnlyKeys(recovery, ["active", "lastProgressTick", "reason", "sinceTick"]) &&
    recovery.active === true &&
    isNonNegativeInteger(recovery.lastProgressTick) &&
    (recovery.reason === "corrupt-root" || recovery.reason === "schema-migration") &&
    isNonNegativeInteger(recovery.sinceTick)
  )) {
    return false;
  }

  if (migration.id === LEGACY_MEMORY_MIGRATION_ID) {
    return (
      value.schemaVersion === LEGACY_MEMORY_SCHEMA_VERSION &&
      value.targetSchemaVersion === PREVIOUS_MEMORY_SCHEMA_VERSION &&
      migration.fromVersion === LEGACY_MEMORY_SCHEMA_VERSION &&
      migration.targetVersion === PREVIOUS_MEMORY_SCHEMA_VERSION &&
      migration.nextStep < LEGACY_MEMORY_MIGRATION_STEP_COUNT &&
      migration.stepCount === LEGACY_MEMORY_MIGRATION_STEP_COUNT
    );
  }

  return (
    value.schemaVersion === PREVIOUS_MEMORY_SCHEMA_VERSION &&
    value.targetSchemaVersion === MEMORY_TARGET_SCHEMA_VERSION &&
    migration.id === MEMORY_MIGRATION_ID &&
    migration.fromVersion === PREVIOUS_MEMORY_SCHEMA_VERSION &&
    migration.targetVersion === MEMORY_TARGET_SCHEMA_VERSION &&
    migration.nextStep < MEMORY_MIGRATION_STEP_COUNT &&
    migration.stepCount === MEMORY_MIGRATION_STEP_COUNT
  );
}

function isDiagnosticHistory(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MEMORY_DIAGNOSTICS &&
    value.every(
      (entry) =>
        isPlainObject(entry) &&
        hasOnlyKeys(entry, ["code", "tick", "detail"]) &&
        (entry.code === "migration-complete" || entry.code === "recovery-start") &&
        isNonNegativeInteger(entry.tick) &&
        typeof entry.detail === "string" &&
        entry.detail.length <= 128,
    )
  );
}

function expectedMigrationOwners(
  migration: MemoryMigrationCursor,
): readonly PersistentStateOwner[] | null {
  if (migration.id === MEMORY_MIGRATION_ID) {
    return migration.nextStep === 0 ? PREVIOUS_PERSISTENT_STATE_OWNERS : null;
  }

  switch (migration.nextStep) {
    case 0:
      return [];
    case 1:
      return ["kernel", "empire", "colonies", "contracts"];
    case 2:
      return [
        "kernel",
        "empire",
        "colonies",
        "contracts",
        "diplomacy",
        "remotes",
        "expansion",
        "operations",
        "industry",
      ];
    case 3:
      return PREVIOUS_PERSISTENT_STATE_OWNERS;
    default:
      return null;
  }
}

function allowedMigrationOwners(migration: MemoryMigrationCursor): readonly string[] {
  return migration.id === MEMORY_MIGRATION_ID
    ? PERSISTENT_STATE_OWNERS
    : PREVIOUS_PERSISTENT_STATE_OWNERS;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function appendPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function invalid(path: string, message: string): JsonValidationFailure {
  return { valid: false, path, message };
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item));
  }

  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      clone[key] = cloneJson(value[key]);
    }
    return clone;
  }

  return value;
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
    Object.freeze(value);
  }

  return value;
}
