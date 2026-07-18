import { canonicalSerialize } from "./canonical";
import { sha256Utf8 } from "./sha256";

export const PHASE2_GATE_THRESHOLD_SCHEMA_VERSION = 1 as const;
export const PHASE2_GATE_MEASUREMENT_SCHEMA_VERSION = 1 as const;
export const PHASE2_GATE_DECLARATION_SHA256_V1 =
  "sha256:ecc728959ca26151df59f005fffee04dd7692502aedf71d008ccabe498912380" as const;

export type Phase2GateComparison = "at-least" | "at-most" | "exactly";
export type Phase2GateScope =
  "complete-gate" | "nominal" | "progression" | "recovery" | "steady-state";
export type Phase2GateUnit =
  "basis-points" | "bytes" | "count" | "cpu" | "energy" | "hits" | "ticks" | "units";

export interface Phase2GateLimit {
  readonly id: string;
  readonly scope: Phase2GateScope;
  readonly comparison: Phase2GateComparison;
  readonly value: number;
  readonly unit: Phase2GateUnit;
}

export interface Phase2GateThresholdManifest {
  readonly schemaVersion: typeof PHASE2_GATE_THRESHOLD_SCHEMA_VERSION;
  readonly issue: 53;
  readonly evidenceIssue: 54;
  readonly status: "declared";
  readonly evidence: {
    readonly progressionSeed: string;
    readonly steadyStateSeed: string;
    readonly variants: readonly ["warm", "reset", "reordered"];
    readonly exactProductionBundle: true;
  };
  readonly fixture: {
    readonly ownedColonies: number;
    readonly normalSources: number;
    readonly sourceEnergyCapacity: number;
    readonly sourceRegenerationTicks: number;
    readonly sourceEnergyPerTick: number;
    readonly boostedControllerUpgrade: false;
    readonly powerControllerUpgrade: false;
  };
  readonly progression: {
    readonly minimumUpgradeEnergyPerTick: number;
    readonly maximumTotalTicks: number;
    readonly transitions: readonly {
      readonly destinationRcl: number;
      readonly progressRequired: number;
      readonly maximumTicks: number;
      readonly limitId: string;
    }[];
  };
  readonly steadyState: {
    readonly durationTicks: number;
    readonly minimumSustainingTicks: number;
    readonly minimumFinalSustainingTicks: number;
    readonly persistentGrowthWindowTicks: number;
    readonly preloadedIndustryInputs: true;
  };
  readonly limits: readonly Phase2GateLimit[];
  readonly injections: readonly {
    readonly id: string;
    readonly recoveryLimitId: string;
  }[];
}

export interface Phase2GateMeasurementSet {
  readonly schemaVersion: typeof PHASE2_GATE_MEASUREMENT_SCHEMA_VERSION;
  readonly issue: 54;
  readonly attestation: {
    readonly manifestSha256: string;
    readonly measurementSha256: string;
    readonly productionBundleSha256: string;
    readonly progression: Phase2GateRunAttestation;
    readonly steadyState: Phase2GateRunAttestation;
  };
  readonly values: readonly {
    readonly id: string;
    readonly value: number;
  }[];
}

export interface Phase2GateRunAttestation {
  readonly seed: string;
  readonly warmOutcomeHash: string;
  readonly resetOutcomeHash: string;
  readonly reorderedOutcomeHash: string;
}

export interface Phase2GateBlocker {
  readonly id: string;
  readonly comparison: Phase2GateComparison;
  readonly expected: number;
  readonly actual: number | null;
  readonly reason: "above-maximum" | "below-minimum" | "inconsistent" | "missing" | "not-equal";
}

export interface Phase2GateEvaluation {
  /** Scalar compliance only; issue #54's collector owns the final gate pass. */
  readonly status: "blocked" | "within-thresholds";
  readonly blockers: readonly Phase2GateBlocker[];
}

const COMPARISONS = new Set<Phase2GateComparison>(["at-least", "at-most", "exactly"]);
const SCOPES = new Set<Phase2GateScope>([
  "complete-gate",
  "nominal",
  "progression",
  "recovery",
  "steady-state",
]);
const UNITS = new Set<Phase2GateUnit>([
  "basis-points",
  "bytes",
  "count",
  "cpu",
  "energy",
  "hits",
  "ticks",
  "units",
]);
const MAX_GATE_LIMITS = 128;
const MAX_GATE_INJECTIONS = 32;

export const PHASE2_GATE_REQUIRED_LIMIT_IDS = Object.freeze([
  "progression-rcl3-ticks",
  "progression-rcl4-ticks",
  "progression-rcl5-ticks",
  "progression-rcl6-ticks",
  "progression-rcl7-ticks",
  "progression-rcl8-ticks",
  "progression-total-ticks",
  "steady-state-observed-ticks",
  "steady-state-sustaining-ticks",
  "steady-state-final-sustaining-ticks",
  "average-cpu-to-limit",
  "minimum-cpu-tail-headroom",
  "minimum-nominal-bucket",
  "minimum-final-bucket",
  "minimum-injected-bucket",
  "persistent-memory-bytes",
  "final-window-persistent-growth",
  "telemetry-owner-bytes",
  "tick-telemetry-bytes",
  "cache-entries",
  "cache-namespaces",
  "minimum-controller-downgrade-margin",
  "minimum-spawn-energy",
  "minimum-terminal-energy",
  "source-uptime",
  "source-waste",
  "spawn-utilization",
  "logistics-fulfillment",
  "flow-identity-absolute-residual",
  "nominal-reserve-violations",
  "nominal-authority-failures",
  "dropped-observer-inputs",
  "rcl-evidence-interruptions",
  "unrestored-attrition-hits",
  "nominal-structures-lost",
  "final-construction-backlog",
  "settled-lab-effects",
  "settled-factory-effects",
  "settled-power-effects",
  "resource-policy-observations",
  "settled-link-transfers",
  "observer-ready-observations",
  "continuous-cooldown-observation-ticks",
  "observed-cooldown-kinds",
  "duplicate-commitments",
  "manual-recovery-commands",
  "forbidden-later-phase-actions",
  "heap-reset-recovery-ticks",
  "memory-recovery-ticks",
  "worker-loss-recovery-ticks",
  "spawn-loss-recovery-ticks",
  "structure-loss-recovery-ticks",
  "blocked-logistics-recovery-ticks",
  "controller-risk-recovery-ticks",
  "low-bucket-recovery-ticks",
  "resource-shortage-recovery-ticks",
  "command-error-recovery-ticks",
  "hostile-pressure-recovery-ticks",
] as const);

const REQUIRED_INJECTIONS = Object.freeze([
  ["heap-reset", "heap-reset-recovery-ticks"],
  ["memory-recovery", "memory-recovery-ticks"],
  ["worker-loss", "worker-loss-recovery-ticks"],
  ["spawn-loss", "spawn-loss-recovery-ticks"],
  ["structure-loss", "structure-loss-recovery-ticks"],
  ["blocked-logistics", "blocked-logistics-recovery-ticks"],
  ["controller-risk", "controller-risk-recovery-ticks"],
  ["low-bucket", "low-bucket-recovery-ticks"],
  ["resource-shortage", "resource-shortage-recovery-ticks"],
  ["command-error", "command-error-recovery-ticks"],
  ["hostile-pressure", "hostile-pressure-recovery-ticks"],
] as const);

/**
 * Validates and detaches the source-controlled declaration consumed by the Phase 2 gate soak.
 * It accepts declarations only; measured values live in issue #54's separate evidence artifact.
 */
export function validatePhase2GateThresholds(value: unknown): Phase2GateThresholdManifest {
  const root = record(value, "Phase 2 gate threshold manifest");
  exactKeys(root, [
    "schemaVersion",
    "issue",
    "evidenceIssue",
    "status",
    "evidence",
    "fixture",
    "progression",
    "steadyState",
    "limits",
    "injections",
  ]);
  if (root.schemaVersion !== PHASE2_GATE_THRESHOLD_SCHEMA_VERSION)
    throw new TypeError("Phase 2 gate threshold schemaVersion must be 1");
  if (root.issue !== 53 || root.evidenceIssue !== 54)
    throw new TypeError("Phase 2 gate thresholds must be declared by issue #53 for issue #54");
  if (root.status !== "declared")
    throw new TypeError("Phase 2 gate threshold status must remain declared before measurement");

  const evidence = parseEvidence(root.evidence);
  const fixture = parseFixture(root.fixture);
  const limits = parseLimits(root.limits);
  const limitsById = new Map(limits.map((limit) => [limit.id, limit] as const));
  const progression = parseProgression(root.progression, fixture, limitsById);
  const steadyState = parseSteadyState(root.steadyState, limitsById);
  const injections = parseInjections(root.injections, limitsById);

  const manifest = Object.freeze({
    schemaVersion: PHASE2_GATE_THRESHOLD_SCHEMA_VERSION,
    issue: 53 as const,
    evidenceIssue: 54 as const,
    status: "declared" as const,
    evidence,
    fixture,
    progression,
    steadyState,
    limits,
    injections,
  });
  if (phase2GateSha256(manifest) !== PHASE2_GATE_DECLARATION_SHA256_V1)
    throw new TypeError("Phase 2 gate declaration changed without a schema revision");
  return manifest;
}

/** Evaluates one complete #54 measurement set. Missing values block rather than becoming zero. */
export function evaluatePhase2Gate(
  manifestInput: Phase2GateThresholdManifest,
  measurementsInput: unknown,
): Phase2GateEvaluation {
  const manifest = validatePhase2GateThresholds(manifestInput);
  const measurementRoot = record(measurementsInput, "Phase 2 gate measurements");
  exactKeys(measurementRoot, ["schemaVersion", "issue", "attestation", "values"]);
  if (
    measurementRoot.schemaVersion !== PHASE2_GATE_MEASUREMENT_SCHEMA_VERSION ||
    measurementRoot.issue !== manifest.evidenceIssue
  )
    throw new TypeError("Phase 2 gate measurements are malformed");
  const measurementItems = boundedArray(
    measurementRoot.values,
    MAX_GATE_LIMITS,
    "Phase 2 gate measurement values",
  );
  parseMeasurementAttestation(measurementRoot.attestation, manifest, measurementItems);
  const limitsById = new Map(manifest.limits.map((limit) => [limit.id, limit] as const));
  const values = new Map<string, number>();
  for (const measurement of measurementItems) {
    const item = record(measurement, "Phase 2 gate measurement");
    exactKeys(item, ["id", "value"]);
    const id = identifier(item.id, "measurement id");
    const limit = limitsById.get(id);
    if (limit === undefined) throw new TypeError(`unknown measurement ${id}`);
    if (values.has(id)) throw new TypeError(`duplicate measurement ${id}`);
    values.set(id, quantizeMeasurement(limit, item.value));
  }

  const blockers: Phase2GateBlocker[] = [];
  for (const limit of manifest.limits) {
    const actual = values.get(limit.id);
    if (actual === undefined) {
      blockers.push(blocker(limit, null, "missing"));
      continue;
    }
    if (limit.comparison === "at-most" && actual > limit.value)
      blockers.push(blocker(limit, actual, "above-maximum"));
    if (limit.comparison === "at-least" && actual < limit.value)
      blockers.push(blocker(limit, actual, "below-minimum"));
    if (limit.comparison === "exactly" && actual !== limit.value)
      blockers.push(blocker(limit, actual, "not-equal"));
  }
  appendConsistencyBlockers(manifest, values, blockers);
  return Object.freeze({
    status: blockers.length === 0 ? "within-thresholds" : "blocked",
    blockers: Object.freeze(blockers),
  });
}

export function phase2GateSha256(value: unknown): string {
  return `sha256:${sha256Utf8(canonicalSerialize(value))}`;
}

function parseMeasurementAttestation(
  value: unknown,
  manifest: Phase2GateThresholdManifest,
  measurements: readonly unknown[],
): void {
  const input = record(value, "Phase 2 gate measurement attestation");
  exactKeys(input, [
    "manifestSha256",
    "measurementSha256",
    "productionBundleSha256",
    "progression",
    "steadyState",
  ]);
  if (input.manifestSha256 !== phase2GateSha256(manifest))
    throw new TypeError("Phase 2 gate measurement manifest SHA-256 does not match");
  if (input.measurementSha256 !== phase2GateSha256(measurements))
    throw new TypeError("Phase 2 gate measurement SHA-256 does not match");
  if (
    typeof input.productionBundleSha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.productionBundleSha256)
  )
    throw new TypeError("Phase 2 gate measurement requires an exact production bundle hash");
  parseRunAttestation(input.progression, manifest.evidence.progressionSeed, "progression");
  parseRunAttestation(input.steadyState, manifest.evidence.steadyStateSeed, "steady-state");
}

function parseRunAttestation(value: unknown, expectedSeed: string, name: string): void {
  const input = record(value, `Phase 2 ${name} run attestation`);
  exactKeys(input, ["seed", "warmOutcomeHash", "resetOutcomeHash", "reorderedOutcomeHash"]);
  if (input.seed !== expectedSeed) throw new TypeError(`Phase 2 ${name} seed does not match`);
  const hashes = [input.warmOutcomeHash, input.resetOutcomeHash, input.reorderedOutcomeHash];
  if (
    hashes.some((hash) => typeof hash !== "string" || !/^fnv1a64-utf16:[0-9a-f]{16}$/u.test(hash))
  )
    throw new TypeError(`Phase 2 ${name} outcome hash is malformed`);
  if (hashes[0] !== hashes[1] || hashes[0] !== hashes[2])
    throw new TypeError(`Phase 2 ${name} outcome equivalence is not proved`);
}

function quantizeMeasurement(limit: Phase2GateLimit, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError(`measurement ${limit.id} must be finite and non-negative`);
  if (limit.unit === "basis-points" && value > 10_000)
    throw new TypeError(`basis-point measurement ${limit.id} exceeds 10,000`);
  const quantized =
    limit.comparison === "at-most"
      ? Math.ceil(value)
      : limit.comparison === "at-least"
        ? Math.floor(value)
        : value;
  if (!Number.isSafeInteger(quantized))
    throw new TypeError(`measurement ${limit.id} does not quantize to a safe integer`);
  return quantized;
}

function appendConsistencyBlockers(
  manifest: Phase2GateThresholdManifest,
  values: ReadonlyMap<string, number>,
  blockers: Phase2GateBlocker[],
): void {
  const transitions = manifest.progression.transitions.map(({ limitId }) => values.get(limitId));
  const total = values.get("progression-total-ticks");
  if (transitions.every((value): value is number => value !== undefined)) {
    for (const [index, value] of transitions.entries()) {
      if (value < 1) {
        const transition = manifest.progression.transitions[index];
        if (transition !== undefined)
          blockers.push(derivedBlocker(transition.limitId, "at-least", 1, value));
      }
    }
    const transitionTotal = transitions.reduce((sum, value) => sum + value, 0);
    if (total !== undefined && total !== transitionTotal)
      blockers.push(derivedBlocker("progression-total-ticks", "exactly", transitionTotal, total));
  }

  const observed = values.get("steady-state-observed-ticks");
  const sustaining = values.get("steady-state-sustaining-ticks");
  const finalSustaining = values.get("steady-state-final-sustaining-ticks");
  const cooldown = values.get("continuous-cooldown-observation-ticks");
  if (observed !== undefined && sustaining !== undefined && sustaining > observed)
    blockers.push(derivedBlocker("steady-state-sustaining-ticks", "at-most", observed, sustaining));
  if (finalSustaining !== undefined && sustaining !== undefined && finalSustaining > sustaining)
    blockers.push(
      derivedBlocker("steady-state-final-sustaining-ticks", "at-most", sustaining, finalSustaining),
    );
  if (cooldown !== undefined && observed !== undefined && cooldown > observed)
    blockers.push(
      derivedBlocker("continuous-cooldown-observation-ticks", "at-most", observed, cooldown),
    );
}

function derivedBlocker(
  id: string,
  comparison: Phase2GateComparison,
  expected: number,
  actual: number,
): Phase2GateBlocker {
  return Object.freeze({ id, comparison, expected, actual, reason: "inconsistent" });
}

function parseEvidence(value: unknown): Phase2GateThresholdManifest["evidence"] {
  const input = record(value, "Phase 2 gate evidence contract");
  exactKeys(input, ["progressionSeed", "steadyStateSeed", "variants", "exactProductionBundle"]);
  const progressionSeed = identifier(input.progressionSeed, "progression seed");
  const steadyStateSeed = identifier(input.steadyStateSeed, "steady-state seed");
  if (progressionSeed !== "phase2-progression-v1" || steadyStateSeed !== "phase2-steady-state-v1")
    throw new TypeError("Phase 2 gate evidence seeds must remain pinned");
  const variants = boundedArray(input.variants, 3, "Phase 2 gate evidence variants");
  if (
    variants.length !== 3 ||
    variants[0] !== "warm" ||
    variants[1] !== "reset" ||
    variants[2] !== "reordered"
  )
    throw new TypeError("Phase 2 gate evidence requires warm, reset, and reordered variants");
  if (input.exactProductionBundle !== true)
    throw new TypeError("Phase 2 gate requires exact production-bundle evidence");
  return Object.freeze({
    progressionSeed,
    steadyStateSeed,
    variants: Object.freeze(["warm", "reset", "reordered"] as const),
    exactProductionBundle: true,
  });
}

function parseFixture(value: unknown): Phase2GateThresholdManifest["fixture"] {
  const input = record(value, "Phase 2 gate fixture");
  exactKeys(input, [
    "ownedColonies",
    "normalSources",
    "sourceEnergyCapacity",
    "sourceRegenerationTicks",
    "sourceEnergyPerTick",
    "boostedControllerUpgrade",
    "powerControllerUpgrade",
  ]);
  const fixture = {
    ownedColonies: positiveInteger(input.ownedColonies, "fixture ownedColonies"),
    normalSources: positiveInteger(input.normalSources, "fixture normalSources"),
    sourceEnergyCapacity: positiveInteger(input.sourceEnergyCapacity, "source energy capacity"),
    sourceRegenerationTicks: positiveInteger(
      input.sourceRegenerationTicks,
      "source regeneration ticks",
    ),
    sourceEnergyPerTick: positiveInteger(input.sourceEnergyPerTick, "source energy per tick"),
    boostedControllerUpgrade: input.boostedControllerUpgrade,
    powerControllerUpgrade: input.powerControllerUpgrade,
  };
  if (
    fixture.ownedColonies !== 1 ||
    fixture.normalSources !== 2 ||
    fixture.sourceEnergyCapacity !== 3_000 ||
    fixture.sourceRegenerationTicks !== 300
  )
    throw new TypeError("Phase 2 gate fixture must pin one colony with two ordinary sources");
  if (fixture.boostedControllerUpgrade !== false || fixture.powerControllerUpgrade !== false)
    throw new TypeError("Phase 2 progression must remain unboosted and unpowered");
  const generatedPerTick =
    (fixture.normalSources * fixture.sourceEnergyCapacity) / fixture.sourceRegenerationTicks;
  if (!Number.isSafeInteger(generatedPerTick) || generatedPerTick !== fixture.sourceEnergyPerTick)
    throw new TypeError("fixture source energy per tick is inconsistent");
  return Object.freeze(fixture as Phase2GateThresholdManifest["fixture"]);
}

function parseProgression(
  value: unknown,
  fixture: Phase2GateThresholdManifest["fixture"],
  limitsById: ReadonlyMap<string, Phase2GateLimit>,
): Phase2GateThresholdManifest["progression"] {
  const input = record(value, "Phase 2 progression thresholds");
  exactKeys(input, ["minimumUpgradeEnergyPerTick", "maximumTotalTicks", "transitions"]);
  const minimumUpgradeEnergyPerTick = positiveInteger(
    input.minimumUpgradeEnergyPerTick,
    "minimum upgrade energy per tick",
  );
  if (minimumUpgradeEnergyPerTick > fixture.sourceEnergyPerTick)
    throw new TypeError("minimum upgrade energy exceeds fixture source income");
  const rawTransitions = boundedArray(input.transitions, 6, "progression transitions");
  if (rawTransitions.length !== 6)
    throw new TypeError("Phase 2 progression requires exactly six adjacent transitions");
  const transitions = rawTransitions.map((raw, index) => {
    const item = record(raw, "progression transition");
    exactKeys(item, ["destinationRcl", "progressRequired", "maximumTicks", "limitId"]);
    const destinationRcl = positiveInteger(item.destinationRcl, "destination RCL");
    const progressRequired = positiveInteger(item.progressRequired, "required controller progress");
    const maximumTicks = positiveInteger(item.maximumTicks, "transition maximum ticks");
    const limitId = identifier(item.limitId, "transition limit id");
    if (destinationRcl !== index + 3)
      throw new TypeError("Phase 2 progression destinations must be adjacent RCL3-RCL8");
    if (maximumTicks !== Math.ceil(progressRequired / minimumUpgradeEnergyPerTick))
      throw new TypeError(
        `RCL${String(destinationRcl)} transition ceiling is mechanically inconsistent`,
      );
    requireLimit(limitsById, limitId, "progression", "at-most", maximumTicks, "ticks");
    return Object.freeze({ destinationRcl, progressRequired, maximumTicks, limitId });
  });
  const maximumTotalTicks = positiveInteger(input.maximumTotalTicks, "maximum total ticks");
  const derivedTotal = transitions.reduce(
    (total, transition) => total + transition.maximumTicks,
    0,
  );
  if (maximumTotalTicks !== derivedTotal)
    throw new TypeError("progression total must equal all adjacent transition ceilings");
  requireLimit(
    limitsById,
    "progression-total-ticks",
    "progression",
    "at-most",
    maximumTotalTicks,
    "ticks",
  );
  return Object.freeze({
    minimumUpgradeEnergyPerTick,
    maximumTotalTicks,
    transitions: Object.freeze(transitions),
  });
}

function parseSteadyState(
  value: unknown,
  limitsById: ReadonlyMap<string, Phase2GateLimit>,
): Phase2GateThresholdManifest["steadyState"] {
  const input = record(value, "Phase 2 steady-state thresholds");
  exactKeys(input, [
    "durationTicks",
    "minimumSustainingTicks",
    "minimumFinalSustainingTicks",
    "persistentGrowthWindowTicks",
    "preloadedIndustryInputs",
  ]);
  const durationTicks = positiveInteger(input.durationTicks, "steady-state duration");
  const minimumSustainingTicks = positiveInteger(
    input.minimumSustainingTicks,
    "minimum sustaining ticks",
  );
  const minimumFinalSustainingTicks = positiveInteger(
    input.minimumFinalSustainingTicks,
    "minimum final sustaining ticks",
  );
  const persistentGrowthWindowTicks = positiveInteger(
    input.persistentGrowthWindowTicks,
    "persistent growth window ticks",
  );
  if (
    minimumSustainingTicks > durationTicks ||
    minimumFinalSustainingTicks > minimumSustainingTicks ||
    persistentGrowthWindowTicks > durationTicks
  )
    throw new TypeError("steady-state evidence windows exceed the soak duration");
  if (input.preloadedIndustryInputs !== true)
    throw new TypeError("steady-state industry exercise requires pinned preloaded inputs");
  requireLimit(
    limitsById,
    "steady-state-observed-ticks",
    "steady-state",
    "exactly",
    durationTicks,
    "ticks",
  );
  requireLimit(
    limitsById,
    "steady-state-sustaining-ticks",
    "steady-state",
    "at-least",
    minimumSustainingTicks,
    "ticks",
  );
  requireLimit(
    limitsById,
    "steady-state-final-sustaining-ticks",
    "steady-state",
    "at-least",
    minimumFinalSustainingTicks,
    "ticks",
  );
  requireLimit(
    limitsById,
    "continuous-cooldown-observation-ticks",
    "steady-state",
    "exactly",
    durationTicks,
    "ticks",
  );
  return Object.freeze({
    durationTicks,
    minimumSustainingTicks,
    minimumFinalSustainingTicks,
    persistentGrowthWindowTicks,
    preloadedIndustryInputs: true,
  });
}

function parseLimits(value: unknown): readonly Phase2GateLimit[] {
  const input = boundedArray(value, MAX_GATE_LIMITS, "Phase 2 gate limits");
  const seen = new Set<string>();
  const limits = input.map((raw) => {
    const item = record(raw, "Phase 2 gate limit");
    exactKeys(item, ["id", "scope", "comparison", "value", "unit"]);
    const id = identifier(item.id, "limit id");
    if (seen.has(id)) throw new TypeError(`duplicate limit ${id}`);
    seen.add(id);
    if (!SCOPES.has(item.scope as Phase2GateScope)) throw new TypeError(`invalid scope for ${id}`);
    if (!COMPARISONS.has(item.comparison as Phase2GateComparison))
      throw new TypeError(`invalid comparison for ${id}`);
    if (!UNITS.has(item.unit as Phase2GateUnit)) throw new TypeError(`invalid unit for ${id}`);
    const threshold = safeNonNegativeInteger(item.value, `limit ${id}`);
    if (item.unit === "basis-points" && threshold > 10_000)
      throw new TypeError(`basis-points limit ${id} exceeds 10,000`);
    return Object.freeze({
      id,
      scope: item.scope as Phase2GateScope,
      comparison: item.comparison as Phase2GateComparison,
      value: threshold,
      unit: item.unit as Phase2GateUnit,
    });
  });
  for (let index = 0; index < PHASE2_GATE_REQUIRED_LIMIT_IDS.length; index += 1) {
    if (limits[index]?.id !== PHASE2_GATE_REQUIRED_LIMIT_IDS[index])
      throw new TypeError("Phase 2 gate required limit vocabulary or order changed");
  }
  if (limits.length !== PHASE2_GATE_REQUIRED_LIMIT_IDS.length)
    throw new TypeError("Phase 2 gate required limit vocabulary or order changed");
  return Object.freeze(limits);
}

function parseInjections(
  value: unknown,
  limitsById: ReadonlyMap<string, Phase2GateLimit>,
): Phase2GateThresholdManifest["injections"] {
  const input = boundedArray(value, MAX_GATE_INJECTIONS, "Phase 2 gate injections");
  if (input.length !== REQUIRED_INJECTIONS.length)
    throw new TypeError("Phase 2 gate recovery mapping is incomplete");
  const seenLimits = new Set<string>();
  return Object.freeze(
    input.map((raw, index) => {
      const item = record(raw, "Phase 2 gate injection");
      exactKeys(item, ["id", "recoveryLimitId"]);
      const id = identifier(item.id, "injection id");
      const recoveryLimitId = identifier(item.recoveryLimitId, "recovery limit id");
      const expected = REQUIRED_INJECTIONS[index];
      if (expected === undefined || id !== expected[0] || recoveryLimitId !== expected[1])
        throw new TypeError("Phase 2 gate recovery mapping or order changed");
      if (seenLimits.has(recoveryLimitId))
        throw new TypeError("Phase 2 gate recovery mapping reuses one limit");
      seenLimits.add(recoveryLimitId);
      const limit = limitsById.get(recoveryLimitId);
      if (
        limit === undefined ||
        limit.scope !== "recovery" ||
        limit.comparison !== "at-most" ||
        limit.unit !== "ticks"
      )
        throw new TypeError(`injection ${id} requires one recovery tick ceiling`);
      return Object.freeze({ id, recoveryLimitId });
    }),
  );
}

function requireLimit(
  limitsById: ReadonlyMap<string, Phase2GateLimit>,
  id: string,
  scope: Phase2GateScope,
  comparison: Phase2GateComparison,
  value: number,
  unit: Phase2GateUnit,
): void {
  const limit = limitsById.get(id);
  if (
    limit === undefined ||
    limit.scope !== scope ||
    limit.comparison !== comparison ||
    limit.value !== value ||
    limit.unit !== unit
  )
    throw new TypeError(`limit ${id} does not match its declared gate boundary`);
}

function blocker(
  limit: Phase2GateLimit,
  actual: number | null,
  reason: Phase2GateBlocker["reason"],
): Phase2GateBlocker {
  return Object.freeze({
    id: limit.id,
    comparison: limit.comparison,
    expected: limit.value,
    actual,
    reason,
  });
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, maximum: number, name: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new TypeError(`${name} must be an array of at most ${String(maximum)} entries`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new TypeError(`unexpected fields: expected ${expected.join(",")}`);
}

function identifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 96 ||
    !/^[a-z][a-z0-9-]*$/u.test(value)
  )
    throw new TypeError(`${name} is invalid`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = safeNonNegativeInteger(value, name);
  if (parsed === 0) throw new TypeError(`${name} must be positive`);
  return parsed;
}

function safeNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${name} must be a non-negative safe integer`);
  return value as number;
}
