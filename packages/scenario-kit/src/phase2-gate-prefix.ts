import { PHASE2_GATE_DECLARATION_SHA256_V1 } from "./phase2-gate";

export const PHASE2_GATE_PREFIX_SCHEMA_VERSION = 1 as const;
export const PHASE2_RCL2_RCL3_PREFIX_ID = "phase2/production/progression-rcl2-rcl3-v1" as const;
export const PHASE2_GATE_PREFIX_ARTIFACT_KIND = "phase2-production-prefix-receipt" as const;
export const PHASE2_GATE_PREFIX_EXECUTOR = "packages/bot/src/runtime/tick.runTick" as const;

export const PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS = Object.freeze([
  "progression-rcl3-ticks",
  "persistent-memory-bytes",
  "telemetry-owner-bytes",
  "tick-telemetry-bytes",
  "cache-entries",
  "cache-namespaces",
  "rcl-evidence-interruptions",
  "forbidden-later-phase-actions",
] as const);

export const PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED = Object.freeze([
  "progression-rcl4-rcl8",
  "progression-total",
  "complete-cpu-and-bucket",
  "final-1024-tick-memory-growth",
  "rcl8-steady-state",
  "recovery-matrix",
  "full-gate-evaluation",
] as const);

const VARIANTS = Object.freeze(["warm", "reset", "reordered"] as const);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BUILD_SHA = /^[A-Za-z0-9._-]{1,128}$/u;
const SEMANTIC_HASH = /^fnv1a64-utf16:[0-9a-f]{16}$/u;
// The pinned world has one spawn, 1,500-tick unboosted creeps, at most 50 body parts, and one
// upgrade intent per actor. 8,192 is a conservative ceiling above its physical transition-tick
// WORK throughput, while still rejecting arbitrary RCL3 progress disguised as crossing overflow.
const MAX_SAME_TICK_RCL3_OVERFLOW_ENERGY = 8_192;

export type Phase2GatePrefixVariantName = (typeof VARIANTS)[number];

export interface Phase2GatePrefixProductionBundleAttestation {
  readonly buildSha: string;
  readonly bytes: number;
  readonly inputCount: number;
  readonly sha256: string;
}

export interface Phase2GatePrefixConfigurationAttestation {
  readonly colonyRclPolicySha256: string;
  readonly runtimeConfigSha256: string;
}

export interface Phase2GatePrefixAttestation {
  readonly thresholdManifestSha256: typeof PHASE2_GATE_DECLARATION_SHA256_V1;
  readonly fixtureSha256: string;
  readonly productionBundle: Phase2GatePrefixProductionBundleAttestation;
  readonly configuration: Phase2GatePrefixConfigurationAttestation;
}

export interface Phase2GatePrefixScope {
  readonly startRcl: 2;
  readonly destinationRcl: 3;
  readonly progressionLimitId: "progression-rcl3-ticks";
  readonly requiredControllerEnergy: 45_000;
  readonly maximumProgressionTicks: 5_000;
  readonly observedLimitIds: typeof PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS;
  readonly notClaimed: typeof PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED;
}

export interface Phase2GatePrefixControllerEvidence {
  readonly startLevel: 2;
  readonly startProgress: 0;
  readonly startProgressTotal: 45_000;
  readonly finalLevel: 3;
  readonly finalProgress: number;
  readonly observedUpgradeEnergy: 45_000;
  readonly totalUpgradeEnergy: number;
  readonly sameTickOverflowEnergy: number;
  readonly directProgressMutations: 0;
}

export interface Phase2GatePrefixDeferredEffectEvidence {
  readonly successfulCalls: number;
  readonly settledEffects: number;
  readonly minimumSettlementDelayTicks: number;
}

export interface Phase2GatePrefixDeferredEffectsEvidence {
  readonly harvest: Phase2GatePrefixDeferredEffectEvidence;
  readonly build: Phase2GatePrefixDeferredEffectEvidence;
  readonly spawn: Phase2GatePrefixDeferredEffectEvidence;
  readonly upgrade: Phase2GatePrefixDeferredEffectEvidence;
  readonly sameTickEffects: 0;
  readonly invalidSettlementDelays: 0;
}

export interface Phase2GatePrefixStateEvidence {
  readonly maximumPersistentMemoryBytes: number;
  readonly maximumTelemetryOwnerBytes: number;
  readonly maximumTickTelemetryBytes: number;
  readonly maximumCacheEntries: number;
  readonly maximumCacheNamespaces: number;
}

export interface Phase2GatePrefixVariantEvidence {
  readonly name: Phase2GatePrefixVariantName;
  readonly collectionOrder: "forward" | "reversed";
  readonly resetAtProgressionTicks: readonly number[];
  readonly firstTick: number;
  readonly progressionTicks: number;
  readonly runTickCalls: number;
  readonly skippedTicks: 0;
  readonly controller: Phase2GatePrefixControllerEvidence;
  readonly deferredEffects: Phase2GatePrefixDeferredEffectsEvidence;
  readonly state: Phase2GatePrefixStateEvidence;
  readonly kernelFaults: 0;
  readonly rclEvidenceInterruptions: 0;
  readonly forbiddenLaterPhaseActions: 0;
  readonly semanticHash: string;
}

export interface Phase2GatePrefixReceipt {
  readonly schemaVersion: typeof PHASE2_GATE_PREFIX_SCHEMA_VERSION;
  readonly artifactKind: typeof PHASE2_GATE_PREFIX_ARTIFACT_KIND;
  readonly issue: 54;
  readonly id: typeof PHASE2_RCL2_RCL3_PREFIX_ID;
  readonly gateComplete: false;
  readonly composable: false;
  readonly executor: typeof PHASE2_GATE_PREFIX_EXECUTOR;
  readonly attestation: Phase2GatePrefixAttestation;
  readonly scope: Phase2GatePrefixScope;
  readonly variants: readonly [
    Phase2GatePrefixVariantEvidence,
    Phase2GatePrefixVariantEvidence,
    Phase2GatePrefixVariantEvidence,
  ];
}

/**
 * Validates and detaches the first current-production prefix receipt for issue #54.
 * Prefix receipts are diagnostic, revision-local evidence and can never evaluate the full gate.
 */
export function validatePhase2GatePrefixReceipt(value: unknown): Phase2GatePrefixReceipt {
  const root = record(value, "Phase 2 production prefix receipt");
  exactKeys(root, [
    "schemaVersion",
    "artifactKind",
    "issue",
    "id",
    "gateComplete",
    "composable",
    "executor",
    "attestation",
    "scope",
    "variants",
  ]);
  if (
    root.schemaVersion !== PHASE2_GATE_PREFIX_SCHEMA_VERSION ||
    root.artifactKind !== PHASE2_GATE_PREFIX_ARTIFACT_KIND ||
    root.issue !== 54 ||
    root.id !== PHASE2_RCL2_RCL3_PREFIX_ID
  )
    throw new TypeError("Phase 2 production prefix receipt identity is malformed");
  if (root.gateComplete !== false || root.composable !== false)
    throw new TypeError("Phase 2 production prefix receipt cannot complete or compose the gate");
  if (root.executor !== PHASE2_GATE_PREFIX_EXECUTOR)
    throw new TypeError("Phase 2 production prefix receipt requires production runTick");

  const attestation = parseAttestation(root.attestation);
  const scope = parseScope(root.scope);
  const variants = parseVariants(root.variants);
  if (new Set(variants.map(({ semanticHash }) => semanticHash)).size !== 1)
    throw new TypeError("Phase 2 production prefix semantic hashes diverged");

  return freeze({
    schemaVersion: PHASE2_GATE_PREFIX_SCHEMA_VERSION,
    artifactKind: PHASE2_GATE_PREFIX_ARTIFACT_KIND,
    issue: 54 as const,
    id: PHASE2_RCL2_RCL3_PREFIX_ID,
    gateComplete: false as const,
    composable: false as const,
    executor: PHASE2_GATE_PREFIX_EXECUTOR,
    attestation,
    scope,
    variants,
  });
}

function parseAttestation(value: unknown): Phase2GatePrefixAttestation {
  const input = record(value, "Phase 2 production prefix attestation");
  exactKeys(input, [
    "thresholdManifestSha256",
    "fixtureSha256",
    "productionBundle",
    "configuration",
  ]);
  if (input.thresholdManifestSha256 !== PHASE2_GATE_DECLARATION_SHA256_V1)
    throw new TypeError("Phase 2 production prefix threshold manifest SHA-256 does not match");
  const fixtureSha256 = sha256(input.fixtureSha256, "fixture SHA-256");
  const productionBundle = parseProductionBundle(input.productionBundle);
  const configuration = parseConfiguration(input.configuration);
  return freeze({
    thresholdManifestSha256: PHASE2_GATE_DECLARATION_SHA256_V1,
    fixtureSha256,
    productionBundle,
    configuration,
  });
}

function parseProductionBundle(value: unknown): Phase2GatePrefixProductionBundleAttestation {
  const input = record(value, "Phase 2 production prefix bundle attestation");
  exactKeys(input, ["buildSha", "bytes", "inputCount", "sha256"]);
  if (typeof input.buildSha !== "string" || !BUILD_SHA.test(input.buildSha))
    throw new TypeError("Phase 2 production prefix build SHA is malformed");
  const bytes = positiveInteger(input.bytes, "production bundle bytes");
  const inputCount = positiveInteger(input.inputCount, "production bundle input count");
  const sha256Value = sha256(input.sha256, "production bundle SHA-256");
  return Object.freeze({ buildSha: input.buildSha, bytes, inputCount, sha256: sha256Value });
}

function parseConfiguration(value: unknown): Phase2GatePrefixConfigurationAttestation {
  const input = record(value, "Phase 2 production prefix configuration attestation");
  exactKeys(input, ["colonyRclPolicySha256", "runtimeConfigSha256"]);
  return Object.freeze({
    colonyRclPolicySha256: sha256(input.colonyRclPolicySha256, "colony RCL policy SHA-256"),
    runtimeConfigSha256: sha256(input.runtimeConfigSha256, "runtime config SHA-256"),
  });
}

function parseScope(value: unknown): Phase2GatePrefixScope {
  const input = record(value, "Phase 2 production prefix scope");
  exactKeys(input, [
    "startRcl",
    "destinationRcl",
    "progressionLimitId",
    "requiredControllerEnergy",
    "maximumProgressionTicks",
    "observedLimitIds",
    "notClaimed",
  ]);
  if (
    input.startRcl !== 2 ||
    input.destinationRcl !== 3 ||
    input.progressionLimitId !== "progression-rcl3-ticks" ||
    input.requiredControllerEnergy !== 45_000 ||
    input.maximumProgressionTicks !== 5_000
  )
    throw new TypeError("Phase 2 production prefix scope changed from the frozen RCL2-RCL3 row");
  exactArray(
    input.observedLimitIds,
    PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS,
    "observed limit ids",
  );
  exactArray(input.notClaimed, PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED, "unclaimed rows");
  return freeze({
    startRcl: 2 as const,
    destinationRcl: 3 as const,
    progressionLimitId: "progression-rcl3-ticks" as const,
    requiredControllerEnergy: 45_000 as const,
    maximumProgressionTicks: 5_000 as const,
    observedLimitIds: Object.freeze([...PHASE2_RCL2_RCL3_PREFIX_OBSERVED_LIMIT_IDS]),
    notClaimed: Object.freeze([...PHASE2_RCL2_RCL3_PREFIX_NOT_CLAIMED]),
  });
}

function parseVariants(value: unknown): Phase2GatePrefixReceipt["variants"] {
  if (!Array.isArray(value) || value.length !== VARIANTS.length)
    throw new TypeError("Phase 2 production prefix requires exactly three variants");
  const parsed = value.map((variant, index) => parseVariant(variant, index));
  return Object.freeze(parsed) as Phase2GatePrefixReceipt["variants"];
}

function parseVariant(value: unknown, index: number): Phase2GatePrefixVariantEvidence {
  const input = record(value, "Phase 2 production prefix variant");
  exactKeys(input, [
    "name",
    "collectionOrder",
    "resetAtProgressionTicks",
    "firstTick",
    "progressionTicks",
    "runTickCalls",
    "skippedTicks",
    "controller",
    "deferredEffects",
    "state",
    "kernelFaults",
    "rclEvidenceInterruptions",
    "forbiddenLaterPhaseActions",
    "semanticHash",
  ]);
  const name = VARIANTS[index];
  if (name === undefined || input.name !== name)
    throw new TypeError("Phase 2 production prefix variant order or name changed");
  const collectionOrder = name === "reordered" ? "reversed" : "forward";
  if (input.collectionOrder !== collectionOrder)
    throw new TypeError(`Phase 2 ${name} collection order is malformed`);
  const resetAtProgressionTicks = parseResetTicks(input.resetAtProgressionTicks, name);
  const firstTick = nonNegativeInteger(input.firstTick, `Phase 2 ${name} first tick`);
  const progressionTicks = positiveInteger(
    input.progressionTicks,
    `Phase 2 ${name} progression ticks`,
  );
  if (progressionTicks > 5_000)
    throw new TypeError(`Phase 2 ${name} progression exceeds the 5,000-tick ceiling`);
  if (!Number.isSafeInteger(firstTick + progressionTicks - 1))
    throw new TypeError(`Phase 2 ${name} progression tick range is unsafe`);
  if (input.runTickCalls !== progressionTicks)
    throw new TypeError(`Phase 2 ${name} must execute one production runTick call per tick`);
  if (input.skippedTicks !== 0) throw new TypeError(`Phase 2 ${name} cannot skip production ticks`);
  if (resetAtProgressionTicks.some((tick) => tick > progressionTicks))
    throw new TypeError(`Phase 2 ${name} reset tick was not executed`);

  const controller = parseController(input.controller);
  const deferredEffects = parseDeferredEffects(input.deferredEffects);
  const state = parseState(input.state);
  if (
    input.kernelFaults !== 0 ||
    input.rclEvidenceInterruptions !== 0 ||
    input.forbiddenLaterPhaseActions !== 0
  )
    throw new TypeError(`Phase 2 ${name} contains a forbidden fault or interruption`);
  const semanticHash = canonicalSemanticHash(input.semanticHash, `Phase 2 ${name} semantic hash`);

  return freeze({
    name,
    collectionOrder,
    resetAtProgressionTicks,
    firstTick,
    progressionTicks,
    runTickCalls: progressionTicks,
    skippedTicks: 0 as const,
    controller,
    deferredEffects,
    state,
    kernelFaults: 0 as const,
    rclEvidenceInterruptions: 0 as const,
    forbiddenLaterPhaseActions: 0 as const,
    semanticHash,
  });
}

function parseResetTicks(value: unknown, variant: Phase2GatePrefixVariantName): readonly number[] {
  const expected = variant === "reset" ? [1_000] : [];
  exactArray(value, expected, `${variant} reset ticks`);
  return Object.freeze([...expected]);
}

function parseController(value: unknown): Phase2GatePrefixControllerEvidence {
  const input = record(value, "Phase 2 production prefix controller evidence");
  exactKeys(input, [
    "startLevel",
    "startProgress",
    "startProgressTotal",
    "finalLevel",
    "finalProgress",
    "observedUpgradeEnergy",
    "totalUpgradeEnergy",
    "sameTickOverflowEnergy",
    "directProgressMutations",
  ]);
  const finalProgress = boundedInteger(
    input.finalProgress,
    MAX_SAME_TICK_RCL3_OVERFLOW_ENERGY,
    "final RCL3 progress",
  );
  const totalUpgradeEnergy = positiveInteger(
    input.totalUpgradeEnergy,
    "total observed upgrade energy",
  );
  const sameTickOverflowEnergy = boundedInteger(
    input.sameTickOverflowEnergy,
    MAX_SAME_TICK_RCL3_OVERFLOW_ENERGY,
    "same-tick RCL3 overflow energy",
  );
  if (
    input.startLevel !== 2 ||
    input.startProgress !== 0 ||
    input.startProgressTotal !== 45_000 ||
    input.finalLevel !== 3 ||
    input.observedUpgradeEnergy !== 45_000 ||
    totalUpgradeEnergy !== 45_000 + finalProgress ||
    sameTickOverflowEnergy !== finalProgress ||
    input.directProgressMutations !== 0
  )
    throw new TypeError("Phase 2 production prefix controller evidence is incomplete");
  return Object.freeze({
    startLevel: 2 as const,
    startProgress: 0 as const,
    startProgressTotal: 45_000 as const,
    finalLevel: 3 as const,
    finalProgress,
    observedUpgradeEnergy: 45_000 as const,
    totalUpgradeEnergy,
    sameTickOverflowEnergy,
    directProgressMutations: 0 as const,
  });
}

function parseDeferredEffects(value: unknown): Phase2GatePrefixDeferredEffectsEvidence {
  const input = record(value, "Phase 2 production prefix deferred effects");
  exactKeys(input, [
    "harvest",
    "build",
    "spawn",
    "upgrade",
    "sameTickEffects",
    "invalidSettlementDelays",
  ]);
  if (input.sameTickEffects !== 0 || input.invalidSettlementDelays !== 0)
    throw new TypeError("Phase 2 production prefix effects must settle only on later ticks");
  return freeze({
    harvest: parseDeferredEffect(input.harvest, "harvest"),
    build: parseDeferredEffect(input.build, "build"),
    spawn: parseDeferredEffect(input.spawn, "spawn"),
    upgrade: parseDeferredEffect(input.upgrade, "upgrade"),
    sameTickEffects: 0 as const,
    invalidSettlementDelays: 0 as const,
  });
}

function parseDeferredEffect(value: unknown, name: string): Phase2GatePrefixDeferredEffectEvidence {
  const input = record(value, `Phase 2 ${name} effect evidence`);
  exactKeys(input, ["successfulCalls", "settledEffects", "minimumSettlementDelayTicks"]);
  const successfulCalls = positiveInteger(input.successfulCalls, `${name} successful calls`);
  const settledEffects = positiveInteger(input.settledEffects, `${name} settled effects`);
  const minimumSettlementDelayTicks = positiveInteger(
    input.minimumSettlementDelayTicks,
    `${name} minimum settlement delay`,
  );
  if (successfulCalls !== settledEffects)
    throw new TypeError(`Phase 2 ${name} successful calls and settled effects must match`);
  if (minimumSettlementDelayTicks !== 1)
    throw new TypeError(`Phase 2 ${name} effects must settle on the following tick`);
  return Object.freeze({
    successfulCalls,
    settledEffects,
    minimumSettlementDelayTicks,
  });
}

function parseState(value: unknown): Phase2GatePrefixStateEvidence {
  const input = record(value, "Phase 2 production prefix state evidence");
  exactKeys(input, [
    "maximumPersistentMemoryBytes",
    "maximumTelemetryOwnerBytes",
    "maximumTickTelemetryBytes",
    "maximumCacheEntries",
    "maximumCacheNamespaces",
  ]);
  return Object.freeze({
    maximumPersistentMemoryBytes: boundedInteger(
      input.maximumPersistentMemoryBytes,
      65_536,
      "maximum persistent Memory bytes",
    ),
    maximumTelemetryOwnerBytes: boundedInteger(
      input.maximumTelemetryOwnerBytes,
      8_192,
      "maximum telemetry-owner bytes",
    ),
    maximumTickTelemetryBytes: boundedInteger(
      input.maximumTickTelemetryBytes,
      8_192,
      "maximum tick-telemetry bytes",
    ),
    maximumCacheEntries: boundedInteger(input.maximumCacheEntries, 384, "maximum cache entries"),
    maximumCacheNamespaces: boundedInteger(
      input.maximumCacheNamespaces,
      3,
      "maximum cache namespaces",
    ),
  });
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new TypeError(`unexpected fields: expected ${expected.join(",")}`);
}

function exactArray(value: unknown, expected: readonly unknown[], name: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  )
    throw new TypeError(`Phase 2 production prefix ${name} changed`);
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new TypeError(`Phase 2 production prefix ${name} is malformed`);
  return value;
}

function canonicalSemanticHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !SEMANTIC_HASH.test(value))
    throw new TypeError(`${name} is malformed`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed === 0) throw new TypeError(`${name} must be positive`);
  return parsed;
}

function boundedInteger(value: unknown, maximum: number, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed > maximum) throw new TypeError(`${name} exceeds ${String(maximum)}`);
  return parsed;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${name} must be a non-negative safe integer`);
  return value as number;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
