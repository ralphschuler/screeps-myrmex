import { describe, expect, it } from "vitest";
import checkedThresholds from "../../../docs/phase2-gate-thresholds.json";
import {
  PHASE2_GATE_DECLARATION_SHA256_V1,
  evaluatePhase2Gate,
  phase2GateSha256,
  validatePhase2GateThresholds,
} from "../src";

describe("Phase 2 predeclared gate thresholds (#53)", () => {
  it("pins a mechanically consistent progression and complete bounded gate vocabulary", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);

    expect(manifest.status).toBe("declared");
    expect(manifest.evidenceIssue).toBe(54);
    expect(phase2GateSha256(manifest)).toBe(PHASE2_GATE_DECLARATION_SHA256_V1);
    expect(manifest.fixture).toMatchObject({
      ownedColonies: 1,
      normalSources: 2,
      sourceEnergyCapacity: 3_000,
      sourceRegenerationTicks: 300,
      sourceEnergyPerTick: 20,
    });
    expect(manifest.progression.minimumUpgradeEnergyPerTick).toBe(9);
    expect(
      manifest.progression.transitions.map(({ destinationRcl, progressRequired, maximumTicks }) => [
        destinationRcl,
        progressRequired,
        maximumTicks,
      ]),
    ).toEqual([
      [3, 45_000, 5_000],
      [4, 135_000, 15_000],
      [5, 405_000, 45_000],
      [6, 1_215_000, 135_000],
      [7, 3_645_000, 405_000],
      [8, 10_935_000, 1_215_000],
    ]);
    expect(manifest.progression.maximumTotalTicks).toBe(1_820_000);
    expect(manifest.steadyState.durationTicks).toBe(15_000);
    expect(manifest.steadyState.minimumSustainingTicks).toBe(13_500);
    expect(manifest.steadyState.minimumFinalSustainingTicks).toBe(1_500);
    expect(manifest.steadyState.persistentGrowthWindowTicks).toBe(1_024);
    expect(manifest.steadyState.preloadedIndustryInputs).toBe(true);

    expect(new Set(manifest.limits.map(({ id }) => id)).size).toBe(manifest.limits.length);
    expect(manifest.limits.map(({ id }) => id)).toEqual(REQUIRED_LIMIT_IDS);
    expect(manifest.injections.map(({ id }) => id)).toEqual(REQUIRED_INJECTION_IDS);
  });

  it("fails closed until issue #54 supplies every bounded measurement", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const result = evaluatePhase2Gate(manifest, measurementSet(manifest, []));

    expect(result.status).toBe("blocked");
    expect(result.blockers).toHaveLength(manifest.limits.length);
    expect(result.blockers.every(({ reason }) => reason === "missing")).toBe(true);
  });

  it("evaluates exact boundaries and reports every comparison failure deterministically", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const passing = measurementSet(
      manifest,
      manifest.limits.map(({ id, value }) => ({ id, value })),
    );
    expect(evaluatePhase2Gate(manifest, passing)).toEqual({
      status: "within-thresholds",
      blockers: [],
    });

    const maximum = requiredLimit(manifest, "average-cpu-to-limit");
    const minimum = requiredLimit(manifest, "source-uptime");
    const exact = requiredLimit(manifest, "nominal-reserve-violations");
    const exceeded = measurementSet(
      manifest,
      passing.values.map((measurement) => {
        if (measurement.id === maximum.id) return { ...measurement, value: maximum.value + 1 };
        if (measurement.id === minimum.id) return { ...measurement, value: minimum.value - 1 };
        if (measurement.id === exact.id) return { ...measurement, value: exact.value + 1 };
        return measurement;
      }),
    );

    expect(evaluatePhase2Gate(manifest, exceeded)).toEqual({
      status: "blocked",
      blockers: [
        {
          id: maximum.id,
          comparison: "at-most",
          expected: maximum.value,
          actual: maximum.value + 1,
          reason: "above-maximum",
        },
        {
          id: minimum.id,
          comparison: "at-least",
          expected: minimum.value,
          actual: minimum.value - 1,
          reason: "below-minimum",
        },
        {
          id: exact.id,
          comparison: "exactly",
          expected: exact.value,
          actual: exact.value + 1,
          reason: "not-equal",
        },
      ],
    });
  });

  it("rejects duplicate, post-hoc, and mechanically inconsistent declarations", () => {
    const duplicate = cloneThresholds();
    const duplicateLimit = duplicate.limits[0];
    if (duplicateLimit === undefined) throw new Error("threshold manifest has no limits");
    duplicate.limits[1] = duplicateLimit;
    expect(() => validatePhase2GateThresholds(duplicate)).toThrow(/duplicate limit/u);

    const measured = cloneThresholds();
    measured.status = "measured";
    expect(() => validatePhase2GateThresholds(measured)).toThrow(/status/u);

    const impossible = cloneThresholds();
    const firstTransition = impossible.progression.transitions[0];
    if (firstTransition === undefined) throw new Error("threshold manifest has no transitions");
    firstTransition.maximumTicks -= 1;
    expect(() => validatePhase2GateThresholds(impossible)).toThrow(/transition ceiling/u);

    const boosted = cloneThresholds();
    boosted.fixture.boostedControllerUpgrade = true;
    expect(() => validatePhase2GateThresholds(boosted)).toThrow(/unboosted/u);

    const invalidRatio = cloneThresholds();
    const ratio = invalidRatio.limits.find(({ unit }) => unit === "basis-points");
    if (ratio === undefined) throw new Error("threshold manifest has no basis-point limit");
    ratio.value = 10_001;
    expect(() => validatePhase2GateThresholds(invalidRatio)).toThrow(/basis-points/u);

    const weakened = cloneThresholds();
    const forbidden = weakened.limits.find(({ id }) => id === "forbidden-later-phase-actions");
    if (forbidden === undefined) throw new Error("threshold manifest has no exclusion limit");
    forbidden.comparison = "at-most";
    forbidden.value = 1;
    expect(() => validatePhase2GateThresholds(weakened)).toThrow(/schema revision/u);

    const incomplete = cloneThresholds();
    incomplete.limits = incomplete.limits.filter(
      ({ id }) => id !== "forbidden-later-phase-actions",
    );
    expect(() => validatePhase2GateThresholds(incomplete)).toThrow(/required limit/u);

    const swappedRecoveries = cloneThresholds();
    const firstRecovery = swappedRecoveries.injections[0];
    const secondRecovery = swappedRecoveries.injections[1];
    if (firstRecovery === undefined || secondRecovery === undefined)
      throw new Error("threshold manifest has too few recoveries");
    const firstLimitId = firstRecovery.recoveryLimitId;
    firstRecovery.recoveryLimitId = secondRecovery.recoveryLimitId;
    secondRecovery.recoveryLimitId = firstLimitId;
    expect(() => validatePhase2GateThresholds(swappedRecoveries)).toThrow(/recovery mapping/u);
  });

  it("rejects duplicate or unknown issue #54 measurements", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const id = requiredLimit(manifest, "progression-rcl3-ticks").id;
    expect(() =>
      evaluatePhase2Gate(
        manifest,
        measurementSet(manifest, [
          { id, value: 1 },
          { id, value: 1 },
        ]),
      ),
    ).toThrow(/duplicate measurement/u);
    expect(() =>
      evaluatePhase2Gate(
        manifest,
        measurementSet(manifest, [{ id: "unknown-gate-input", value: 0 }]),
      ),
    ).toThrow(/unknown measurement/u);
    expect(() =>
      evaluatePhase2Gate(manifest, {
        schemaVersion: 1,
        issue: 54,
        values: [],
      }),
    ).toThrow(/attestation/u);
  });

  it("rejects mismatched fixture and repeatability attestations", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const valid = measurementSet(
      manifest,
      manifest.limits.map(({ id, value }) => ({ id, value })),
    );
    expect(() =>
      evaluatePhase2Gate(manifest, {
        ...valid,
        attestation: {
          ...valid.attestation,
          manifestSha256: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).toThrow(/manifest SHA-256/u);
    expect(() =>
      evaluatePhase2Gate(manifest, {
        ...valid,
        values: valid.values.map((value, index) =>
          index === 0 ? { ...value, value: value.value + 1 } : value,
        ),
      }),
    ).toThrow(/measurement SHA-256/u);
    expect(() =>
      evaluatePhase2Gate(manifest, {
        ...valid,
        attestation: {
          ...valid.attestation,
          progression: {
            ...valid.attestation.progression,
            resetOutcomeHash: "fnv1a64-utf16:fedcba9876543210",
          },
        },
      }),
    ).toThrow(/outcome equivalence/u);
  });

  it("rejects impossible basis-point measurements", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const values = manifest.limits.map(({ id, value }) => ({ id, value }));
    const uptime = values.find(({ id }) => id === "source-uptime");
    if (uptime === undefined) throw new Error("missing source uptime measurement");
    uptime.value = 10_001;
    expect(() => evaluatePhase2Gate(manifest, measurementSet(manifest, values))).toThrow(
      /basis-point measurement/u,
    );
  });

  it("quantizes fractional measurements against the conservative boundary", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const values = manifest.limits.map(({ id, value }) => ({ id, value }));
    const cpu = values.find(({ id }) => id === "average-cpu-to-limit");
    const uptime = values.find(({ id }) => id === "source-uptime");
    if (cpu === undefined || uptime === undefined) throw new Error("missing ratio measurements");
    cpu.value = 6_500.01;
    uptime.value = 9_499.99;

    const result = evaluatePhase2Gate(manifest, measurementSet(manifest, values));

    expect(result.blockers).toContainEqual({
      id: "average-cpu-to-limit",
      comparison: "at-most",
      expected: 6_500,
      actual: 6_501,
      reason: "above-maximum",
    });
    expect(result.blockers).toContainEqual({
      id: "source-uptime",
      comparison: "at-least",
      expected: 9_500,
      actual: 9_499,
      reason: "below-minimum",
    });
  });

  it("blocks internally impossible issue #54 measurements", () => {
    const manifest = validatePhase2GateThresholds(checkedThresholds);
    const values = manifest.limits.map(({ id, value }) => ({ id, value }));
    const replace = (id: string, value: number) => {
      const measurement = values.find((candidate) => candidate.id === id);
      if (measurement === undefined) throw new Error(`missing measurement ${id}`);
      measurement.value = value;
    };
    for (let rcl = 3; rcl <= 8; rcl += 1) replace(`progression-rcl${String(rcl)}-ticks`, 1);
    replace("progression-total-ticks", 1);
    replace("steady-state-sustaining-ticks", 15_001);
    replace("steady-state-final-sustaining-ticks", 15_002);

    const result = evaluatePhase2Gate(manifest, measurementSet(manifest, values));

    expect(result.status).toBe("blocked");
    expect(result.blockers.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: "progression-total-ticks", reason: "inconsistent" },
      { id: "steady-state-sustaining-ticks", reason: "inconsistent" },
      { id: "steady-state-final-sustaining-ticks", reason: "inconsistent" },
    ]);
  });
});

function measurementSet(
  manifest: ReturnType<typeof validatePhase2GateThresholds>,
  values: readonly { readonly id: string; readonly value: number }[],
) {
  const outcomeHash = "fnv1a64-utf16:0123456789abcdef";
  const run = (seed: string) => ({
    seed,
    warmOutcomeHash: outcomeHash,
    resetOutcomeHash: outcomeHash,
    reorderedOutcomeHash: outcomeHash,
  });
  return {
    schemaVersion: 1,
    issue: 54,
    attestation: {
      manifestSha256: phase2GateSha256(manifest),
      measurementSha256: phase2GateSha256(values),
      productionBundleSha256: `sha256:${"a".repeat(64)}`,
      progression: run("phase2-progression-v1"),
      steadyState: run("phase2-steady-state-v1"),
    },
    values,
  };
}

function requiredLimit(manifest: ReturnType<typeof validatePhase2GateThresholds>, id: string) {
  const limit = manifest.limits.find((candidate) => candidate.id === id);
  if (limit === undefined) throw new Error(`missing limit ${id}`);
  return limit;
}

function cloneThresholds(): typeof checkedThresholds {
  return JSON.parse(JSON.stringify(checkedThresholds)) as typeof checkedThresholds;
}

const REQUIRED_INJECTION_IDS = [
  "heap-reset",
  "memory-recovery",
  "worker-loss",
  "spawn-loss",
  "structure-loss",
  "blocked-logistics",
  "controller-risk",
  "low-bucket",
  "resource-shortage",
  "command-error",
  "hostile-pressure",
];

const REQUIRED_LIMIT_IDS = [
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
];
