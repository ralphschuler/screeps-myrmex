import { describe, expect, it } from "vitest";
import checkedResult from "../../../docs/phase1-gate-results.json";
import { collectConstrainedCpuEvidence } from "./phase1-constrained-cpu.test";
import { collectHostilePressureEvidence } from "./phase1-hostile-pressure-recovery.test";
import { collectPathTargetEvidence } from "./phase1-path-target-recovery.test";
import { collectSpawnBlockerEvidence } from "./phase1-spawn-blockers.test";

describe("Phase 1 aggregate deterministic evidence (#30)", () => {
  it("matches checked-in component outputs and keeps unavailable measurements explicit", () => {
    const actual = collectAggregateEvidence();
    expect(actual).toEqual(checkedResult);

    for (const row of actual.rows) {
      for (const value of Object.values(row.measurements)) {
        expect(value === null || (Number.isSafeInteger(value) && value >= 0)).toBe(true);
      }
      for (const [field, value] of Object.entries(row.measurements)) {
        if (value === null) expect(row.unevidenced).toContain(field);
      }
      for (const value of Object.values(row.hashes)) {
        expect(value === null || /^(?:fnv1a64-utf16:)?[0-9a-f]{8,64}$/u.test(value)).toBe(true);
      }
    }

    expect(actual.status).toBe("blocked");
    expect(actual.externalLive).toEqual({
      deployment: "unevidenced",
      engineTiming: "unevidenced",
      hostilePressure: "unevidenced",
      remoteAdapter: "unevidenced",
      rollbackIncident: "unevidenced",
    });
  });
});

export function collectAggregateEvidence() {
  const components = [
    componentRow("spawn-blocker-recovery", collectSpawnBlockerEvidence(), {
      energyFlow: 200,
      recoveryTime: 2,
      spawnUtilizationPct: 25,
    }),
    componentRow("path-target-recovery", collectPathTargetEvidence(), {
      energyFlow: 0,
      recoveryTime: 3,
      spawnUtilizationPct: 0,
    }),
    componentRow("hostile-pressure-recovery", collectHostilePressureEvidence(), {
      recoveryTime: 3,
      spawnUtilizationPct: 0,
    }),
    componentRow("constrained-cpu", collectConstrainedCpuEvidence(), {
      energyFlow: 0,
      recoveryTime: 4,
      spawnUtilizationPct: 0,
    }),
  ];
  const resetReorder = equivalenceRow(components);
  return Object.freeze({
    schemaVersion: 1,
    issue: 30,
    status: "blocked",
    productionBundleExclusion: "evidenced-local",
    externalLive: Object.freeze({
      deployment: "unevidenced",
      engineTiming: "unevidenced",
      hostilePressure: "unevidenced",
      remoteAdapter: "unevidenced",
      rollbackIncident: "unevidenced",
    }),
    rows: Object.freeze([
      unavailableRuntimeRow("rcl2-established", "evidenced"),
      unavailableRuntimeRow("rcl1-cold-boot-growth", "partial"),
      ...components,
      resetReorder,
      aggregateRow(components, resetReorder),
    ]),
  });
}

interface EvidenceRun {
  readonly outcomeHash: string;
  readonly transcript: {
    readonly ticks: readonly { readonly cpu: { readonly used: number } }[];
  };
  readonly transcriptHash: string;
}

interface Runs {
  readonly reordered: EvidenceRun;
  readonly reset: EvidenceRun;
  readonly warm: EvidenceRun;
}
type MeasurementName = keyof ReturnType<typeof emptyMeasurements>;

function componentRow(id: string, runs: Runs, measured: Partial<Record<MeasurementName, number>>) {
  const ticks = runs.warm.transcript.ticks.length;
  const modeledCpu = runs.warm.transcript.ticks.reduce((total, tick) => total + tick.cpu.used, 0);
  return Object.freeze({
    id,
    status: "partial",
    scope: "deterministic-component",
    measurements: Object.freeze({ ...emptyMeasurements(), ticks, modeledCpu, ...measured }),
    hashes: Object.freeze({
      warmOutcome: runs.warm.outcomeHash,
      resetOutcome: runs.reset.outcomeHash,
      reorderedOutcome: runs.reordered.outcomeHash,
      warmTranscript: runs.warm.transcriptHash,
      resetTranscript: runs.reset.transcriptHash,
      reorderedTranscript: runs.reordered.transcriptHash,
    }),
    unevidenced: Object.freeze(
      Object.entries({ ...emptyMeasurements(), ticks, modeledCpu, ...measured })
        .filter(([, value]) => value === null)
        .map(([field]) => field),
    ),
  });
}

function unavailableRuntimeRow(id: string, status: "evidenced" | "partial") {
  return Object.freeze({
    id,
    status,
    scope: "focused-runtime-not-exported",
    measurements: Object.freeze(emptyMeasurements()),
    hashes: Object.freeze(emptyHashes()),
    unevidenced: Object.freeze(Object.keys(emptyMeasurements())),
  });
}

function equivalenceRow(components: readonly ReturnType<typeof componentRow>[]) {
  const warmOutcome = hashText(components.map((row) => row.hashes.warmOutcome).join(":"));
  const resetOutcome = hashText(components.map((row) => row.hashes.resetOutcome).join(":"));
  const reorderedOutcome = hashText(components.map((row) => row.hashes.reorderedOutcome).join(":"));
  const measurements = {
    ...emptyMeasurements(),
    ticks: components.reduce((total, row) => total + row.measurements.ticks, 0),
    modeledCpu: components.reduce((total, row) => total + row.measurements.modeledCpu, 0),
    recoveryTime: Math.max(...components.map((row) => row.measurements.recoveryTime ?? 0)),
  };
  return Object.freeze({
    id: "reset-reorder-equivalence",
    status: "partial",
    scope: "deterministic-component-equivalence",
    measurements: Object.freeze(measurements),
    hashes: Object.freeze({
      warmOutcome,
      resetOutcome,
      reorderedOutcome,
      warmTranscript: hashText(components.map((row) => row.hashes.warmTranscript).join(":")),
      resetTranscript: hashText(components.map((row) => row.hashes.resetTranscript).join(":")),
      reorderedTranscript: hashText(
        components.map((row) => row.hashes.reorderedTranscript).join(":"),
      ),
    }),
    unevidenced: Object.freeze(
      Object.entries(measurements)
        .filter(([, value]) => value === null)
        .map(([field]) => field),
    ),
  });
}

function aggregateRow(
  components: readonly ReturnType<typeof componentRow>[],
  equivalence: ReturnType<typeof equivalenceRow>,
) {
  return Object.freeze({
    id: "aggregate-phase1-matrix",
    status: "unevidenced",
    scope: "local-component-subset",
    measurements: equivalence.measurements,
    hashes: Object.freeze({
      warmOutcome: hashText(components.map((row) => row.hashes.warmOutcome).join("|")),
      resetOutcome: hashText(components.map((row) => row.hashes.resetOutcome).join("|")),
      reorderedOutcome: hashText(components.map((row) => row.hashes.reorderedOutcome).join("|")),
      warmTranscript: null,
      resetTranscript: null,
      reorderedTranscript: null,
    }),
    unevidenced: Object.freeze([
      ...equivalence.unevidenced,
      "warmTranscript",
      "resetTranscript",
      "reorderedTranscript",
      "rcl1RuntimeExport",
      "rcl2RuntimeExport",
      "externalLive",
    ]),
  });
}

function emptyMeasurements() {
  return {
    ticks: null as number | null,
    modeledCpu: null as number | null,
    persistentBytes: null as number | null,
    persistentGrowth: null as number | null,
    telemetryBytes: null as number | null,
    telemetryCardinality: null as number | null,
    spawnUtilizationPct: null as number | null,
    energyFlow: null as number | null,
    replacementLateness: null as number | null,
    controllerMargin: null as number | null,
    controllerRisk: null as number | null,
    recoveryTime: null as number | null,
  };
}

function emptyHashes() {
  return {
    warmOutcome: null,
    resetOutcome: null,
    reorderedOutcome: null,
    warmTranscript: null,
    resetTranscript: null,
    reorderedTranscript: null,
  };
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
