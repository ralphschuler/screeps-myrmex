import {
  RUNTIME_CONFIG_OWNER_SCHEMA_VERSION,
  type RuntimeConfigCandidate,
  type RuntimeConfigLastValid,
  type RuntimeConfigOwnerV1,
  type RuntimeConfigResolution,
  type RuntimeConfigResolutionMetadata,
} from "./authority-contracts";
import { cloneDataPreservingOrder, deepFreeze } from "./canonical";
import type { RuntimeConfig } from "./contracts";
import { RUNTIME_CONFIG_SOURCE_REVISION } from "./defaults";
import { buildRuntimeConfig, SOURCE_DEFAULT_RUNTIME_CONFIG } from "./runtime-config";
import {
  validateRuntimeOverrides,
  type CanonicalRuntimeOverrides,
  type RuntimeOverrideValidation,
} from "./validation";

interface ParsedOwner {
  readonly candidate: RuntimeConfigCandidate | null;
  readonly lastValid: ParsedLastValid | null;
}

interface ParsedLastValid {
  readonly sourceRevision: string;
  readonly candidateRevision: number;
  readonly overrides: unknown;
  readonly resolvedRevision: string;
}

type OwnerRead =
  | { readonly kind: "unavailable" | "empty" | "malformed" | "future" }
  | { readonly kind: "valid"; readonly owner: ParsedOwner };

interface CompatibleLastValid {
  readonly config: RuntimeConfig;
  readonly overrides: CanonicalRuntimeOverrides;
  readonly inputCanonical: string;
  readonly candidateRevision: number;
}

interface CandidateCache {
  readonly revision: number;
  readonly validation: RuntimeOverrideValidation;
  readonly config: RuntimeConfig | null;
}

interface LastValidCache extends CompatibleLastValid {
  readonly sourceRevision: string;
  readonly resolvedRevision: string;
}

/**
 * Sole parser for the operational config owner. The caller remains responsible
 * for staging `replacementOwner` through MemoryManager's transaction boundary.
 */
export class RuntimeConfigAuthority {
  private candidateCache: CandidateCache | null = null;
  private lastValidCache: LastValidCache | null = null;

  public resolve(ownerValue: unknown, tick: number): RuntimeConfigResolution {
    void tick;
    const read = readOwner(ownerValue);
    if (read.kind !== "valid") {
      this.clearCaches();
    }
    switch (read.kind) {
      case "unavailable":
        return result(
          SOURCE_DEFAULT_RUNTIME_CONFIG,
          metadata("owner-unavailable", "owner-unavailable"),
        );
      case "empty":
        return result(
          SOURCE_DEFAULT_RUNTIME_CONFIG,
          metadata("source-defaults", "owner-initialized"),
          createOwner(null, null),
        );
      case "future":
        return result(
          SOURCE_DEFAULT_RUNTIME_CONFIG,
          metadata("source-defaults", "owner-future-schema"),
        );
      case "malformed":
        return result(
          SOURCE_DEFAULT_RUNTIME_CONFIG,
          metadata("source-defaults", "owner-malformed"),
        );
      case "valid":
        return this.resolveValidOwner(read.owner);
    }
  }

  private resolveValidOwner(owner: ParsedOwner): RuntimeConfigResolution {
    if (owner.candidate === null) {
      this.candidateCache = null;
      const lastValid = this.readLastValid(owner.lastValid);
      return lastValid === null
        ? result(SOURCE_DEFAULT_RUNTIME_CONFIG, metadata("source-defaults", "no-candidate"))
        : retained(lastValid, null, "no-candidate");
    }

    const lastValid = this.readLastValid(owner.lastValid);
    if (lastValid !== null && owner.candidate.revision < lastValid.candidateRevision) {
      return retained(lastValid, owner.candidate.revision, "candidate-stale");
    }

    const candidate = this.readCandidate(owner.candidate);
    if (!candidate.valid) {
      return lastValid === null
        ? result(
            SOURCE_DEFAULT_RUNTIME_CONFIG,
            metadata("source-defaults", "candidate-invalid", owner.candidate.revision),
          )
        : retained(lastValid, owner.candidate.revision, "candidate-invalid");
    }

    if (lastValid !== null && owner.candidate.revision === lastValid.candidateRevision) {
      if (candidate.inputCanonical !== lastValid.inputCanonical) {
        return retained(lastValid, owner.candidate.revision, "candidate-revision-reused");
      }
      return result(
        lastValid.config,
        metadata(
          "candidate-accepted",
          "candidate-valid",
          owner.candidate.revision,
          owner.candidate.revision,
        ),
      );
    }

    const config = this.configForCandidate(owner.candidate.revision, candidate.overrides);
    const accepted: RuntimeConfigLastValid = {
      sourceRevision: RUNTIME_CONFIG_SOURCE_REVISION,
      candidateRevision: owner.candidate.revision,
      overrides: candidate.overrides,
      resolvedRevision: config.revision,
    };
    return result(
      config,
      metadata(
        "candidate-accepted",
        "candidate-valid",
        owner.candidate.revision,
        owner.candidate.revision,
      ),
      createOwner(owner.candidate, accepted),
    );
  }

  private readCandidate(candidate: RuntimeConfigCandidate): RuntimeOverrideValidation {
    const cached = this.candidateCache;
    if (cached !== null && cached.revision === candidate.revision) {
      return cached.validation;
    }

    const validation = validateRuntimeOverrides(candidate.overrides);
    this.candidateCache = { revision: candidate.revision, validation, config: null };
    return validation;
  }

  private configForCandidate(
    revision: number,
    overrides: CanonicalRuntimeOverrides,
  ): RuntimeConfig {
    const cached = this.candidateCache;
    if (cached !== null && cached.revision === revision && cached.config !== null) {
      return cached.config;
    }
    const config = buildRuntimeConfig(overrides);
    if (cached !== null && cached.revision === revision) {
      this.candidateCache = { ...cached, config };
    }
    return config;
  }

  private readLastValid(lastValid: ParsedLastValid | null): CompatibleLastValid | null {
    if (lastValid === null || lastValid.sourceRevision !== RUNTIME_CONFIG_SOURCE_REVISION) {
      return null;
    }
    const cached = this.lastValidCache;
    if (
      cached !== null &&
      cached.sourceRevision === lastValid.sourceRevision &&
      cached.candidateRevision === lastValid.candidateRevision &&
      cached.resolvedRevision === lastValid.resolvedRevision
    ) {
      return cached;
    }

    const validation = validateRuntimeOverrides(lastValid.overrides);
    if (!validation.valid) {
      return null;
    }
    const config = buildRuntimeConfig(validation.overrides);
    if (config.revision !== lastValid.resolvedRevision) {
      return null;
    }
    const compatible: LastValidCache = {
      sourceRevision: lastValid.sourceRevision,
      candidateRevision: lastValid.candidateRevision,
      resolvedRevision: lastValid.resolvedRevision,
      config,
      overrides: validation.overrides,
      inputCanonical: validation.inputCanonical,
    };
    this.lastValidCache = compatible;
    return compatible;
  }

  private clearCaches(): void {
    this.candidateCache = null;
    this.lastValidCache = null;
  }
}

function readOwner(value: unknown): OwnerRead {
  if (value === null || value === undefined) {
    return { kind: "unavailable" };
  }
  const root = dataRecord(value);
  if (root === null) {
    return { kind: "malformed" };
  }
  const keys = Object.keys(root);
  if (keys.length === 0) {
    return { kind: "empty" };
  }

  const schemaVersion = dataField(root, "schemaVersion");
  if (
    schemaVersion.present &&
    isNonNegativeSafeInteger(schemaVersion.value) &&
    schemaVersion.value > RUNTIME_CONFIG_OWNER_SCHEMA_VERSION
  ) {
    return { kind: "future" };
  }
  if (!hasOnlyKeys(root, ["schemaVersion", "candidate", "lastValid"])) {
    return { kind: "malformed" };
  }
  const candidateField = dataField(root, "candidate");
  const lastValidField = dataField(root, "lastValid");
  if (
    !schemaVersion.present ||
    schemaVersion.value !== RUNTIME_CONFIG_OWNER_SCHEMA_VERSION ||
    !candidateField.present ||
    !lastValidField.present
  ) {
    return { kind: "malformed" };
  }
  const candidate = parseCandidate(candidateField.value);
  const lastValid = parseLastValid(lastValidField.value);
  if (!candidate.valid || !lastValid.valid) {
    return { kind: "malformed" };
  }
  return { kind: "valid", owner: { candidate: candidate.value, lastValid: lastValid.value } };
}

function parseCandidate(
  value: unknown,
):
  | { readonly valid: true; readonly value: RuntimeConfigCandidate | null }
  | { readonly valid: false } {
  if (value === null) {
    return { valid: true, value: null };
  }
  const record = exactDataRecord(value, ["revision", "overrides"]);
  if (record === null) {
    return { valid: false };
  }
  const revision = dataValue(record, "revision");
  const overrides = dataValue(record, "overrides");
  return isNonNegativeSafeInteger(revision)
    ? { valid: true, value: { revision, overrides } }
    : { valid: false };
}

function parseLastValid(
  value: unknown,
): { readonly valid: true; readonly value: ParsedLastValid | null } | { readonly valid: false } {
  if (value === null) {
    return { valid: true, value: null };
  }
  const record = exactDataRecord(value, [
    "sourceRevision",
    "candidateRevision",
    "overrides",
    "resolvedRevision",
  ]);
  if (record === null) {
    return { valid: false };
  }
  const sourceRevision = dataValue(record, "sourceRevision");
  const candidateRevision = dataValue(record, "candidateRevision");
  const overrides = dataValue(record, "overrides");
  const resolvedRevision = dataValue(record, "resolvedRevision");
  if (
    typeof sourceRevision !== "string" ||
    sourceRevision.length === 0 ||
    sourceRevision.length > 128 ||
    !isNonNegativeSafeInteger(candidateRevision) ||
    typeof resolvedRevision !== "string" ||
    resolvedRevision.length === 0 ||
    resolvedRevision.length > 128
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: { sourceRevision, candidateRevision, overrides, resolvedRevision },
  };
}

function createOwner(
  candidate: RuntimeConfigCandidate | null,
  lastValid: RuntimeConfigLastValid | null,
): RuntimeConfigOwnerV1 {
  return deepFreeze({
    schemaVersion: RUNTIME_CONFIG_OWNER_SCHEMA_VERSION,
    candidate: candidate === null ? null : cloneDataPreservingOrder(candidate),
    lastValid: lastValid === null ? null : cloneDataPreservingOrder(lastValid),
  });
}

function retained(
  lastValid: CompatibleLastValid,
  candidateRevision: number | null,
  reasonCode: RuntimeConfigResolutionMetadata["reasonCode"],
): RuntimeConfigResolution {
  return result(
    lastValid.config,
    metadata("last-valid-retained", reasonCode, candidateRevision, lastValid.candidateRevision),
  );
}

function metadata(
  status: RuntimeConfigResolutionMetadata["status"],
  reasonCode: RuntimeConfigResolutionMetadata["reasonCode"],
  candidateRevision: number | null = null,
  acceptedCandidateRevision: number | null = null,
): RuntimeConfigResolutionMetadata {
  return { status, reasonCode, candidateRevision, acceptedCandidateRevision };
}

function result(
  config: RuntimeConfig,
  resolutionMetadata: RuntimeConfigResolutionMetadata,
  replacementOwner: RuntimeConfigOwnerV1 | null = null,
): RuntimeConfigResolution {
  return deepFreeze({ config, metadata: resolutionMetadata, replacementOwner });
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  const keys = Object.keys(value);
  if (ownKeys.some((key) => typeof key === "symbol") || ownKeys.length !== keys.length) {
    return null;
  }
  for (const key of keys) {
    if (!dataField(value as Record<string, unknown>, key).present) {
      return null;
    }
  }
  return value as Record<string, unknown>;
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = dataRecord(value);
  return record !== null && hasOnlyKeys(record, keys) ? record : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function dataField(
  value: Record<string, unknown>,
  key: string,
): { readonly present: true; readonly value: unknown } | { readonly present: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    ? { present: true, value: descriptor.value }
    : { present: false };
}

function dataValue(value: Record<string, unknown>, key: string): unknown {
  const field = dataField(value, key);
  if (!field.present) {
    throw new TypeError("Validated configuration owner is missing a data field");
  }
  return field.value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

export type {
  RuntimeConfigOwnerV1,
  RuntimeConfigResolution,
  RuntimeConfigResolutionMetadata,
  RuntimeConfigResolutionReason,
  RuntimeConfigResolutionStatus,
} from "./authority-contracts";
