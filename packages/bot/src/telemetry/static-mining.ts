export const STATIC_MINING_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const MAX_STATIC_MINING_TELEMETRY_SOURCES = 64 as const;

export type StaticMinerObservationState = "active" | "idle" | "missing" | "replacement-pending";

export interface StaticMiningSourceObservation {
  readonly sourceId: string;
  readonly energy: number;
  readonly energyCapacity: number;
  readonly ticksToRegeneration: number | null;
  readonly minerState: StaticMinerObservationState;
  readonly container: {
    readonly capacity: number;
    readonly used: number;
    readonly ticksToDecay: number | null;
  } | null;
}

export interface StaticMiningSourceSample {
  readonly sourceId: string;
  readonly energy: number;
  readonly energyCapacity: number;
  readonly observedAt: number;
  readonly ticksToRegeneration: number | null;
}

export interface StaticMiningTelemetryState {
  readonly schemaVersion: typeof STATIC_MINING_TELEMETRY_SCHEMA_VERSION;
  readonly sources: readonly StaticMiningSourceSample[];
}

export interface StaticMiningSourceTelemetry {
  readonly sourceId: string;
  readonly sourceUptimeTicks: 0 | 1;
  readonly harvestedEnergy: number;
  readonly wastedEnergy: number;
  readonly minerIdleTicks: 0 | 1;
  readonly replacementGapTicks: 0 | 1;
  readonly containerFillBasisPoints: number | null;
  readonly containerTicksToDecay: number | null;
}

export interface StaticMiningTelemetry {
  readonly schemaVersion: typeof STATIC_MINING_TELEMETRY_SCHEMA_VERSION;
  readonly observedSources: number;
  readonly droppedSources: number;
  readonly sourceUptimeTicks: number;
  readonly harvestedEnergy: number;
  readonly wastedEnergy: number;
  readonly minerIdleTicks: number;
  readonly replacementGapTicks: number;
  readonly cpuUsed: number;
  readonly cpuPerHarvestedEnergy: number | null;
  readonly sources: readonly StaticMiningSourceTelemetry[];
}

export interface StaticMiningTelemetryReduction {
  readonly state: StaticMiningTelemetryState;
  readonly telemetry: StaticMiningTelemetry;
}

/**
 * Pure observer reducer for static extraction. The returned state is only a bounded previous-source
 * sample; no gameplay planner or executor may consume the telemetry result as authorization.
 */
export function reduceStaticMiningTelemetry(input: {
  readonly tick: number;
  readonly cpuUsed: number;
  readonly observations: readonly StaticMiningSourceObservation[];
  readonly previous?: StaticMiningTelemetryState | null;
  readonly maximumSources?: number;
}): StaticMiningTelemetryReduction {
  const tick = safeInteger(input.tick);
  const limit = Math.min(
    MAX_STATIC_MINING_TELEMETRY_SOURCES,
    input.maximumSources === undefined
      ? MAX_STATIC_MINING_TELEMETRY_SOURCES
      : safeInteger(input.maximumSources),
  );
  const observations = normalizeObservations(input.observations).slice(0, limit);
  const previous = normalizePrevious(input.previous);
  const nextSamples: StaticMiningSourceSample[] = [];
  const sources = observations.map((observation): StaticMiningSourceTelemetry => {
    const prior = previous.get(observation.sourceId);
    const deltas = energyDeltas(prior, observation, tick);
    nextSamples.push({
      sourceId: observation.sourceId,
      energy: observation.energy,
      energyCapacity: observation.energyCapacity,
      observedAt: tick,
      ticksToRegeneration: observation.ticksToRegeneration,
    });
    const container = observation.container;
    return Object.freeze({
      sourceId: observation.sourceId,
      sourceUptimeTicks: observation.minerState === "active" ? 1 : 0,
      harvestedEnergy: deltas.harvested,
      wastedEnergy: deltas.wasted,
      minerIdleTicks: observation.minerState === "idle" ? 1 : 0,
      replacementGapTicks:
        observation.minerState === "missing" || observation.minerState === "replacement-pending"
          ? 1
          : 0,
      containerFillBasisPoints:
        container === null || container.capacity === 0
          ? null
          : Math.min(10_000, Math.floor((container.used * 10_000) / container.capacity)),
      containerTicksToDecay: container?.ticksToDecay ?? null,
    });
  });
  const harvestedEnergy = total(sources.map(({ harvestedEnergy }) => harvestedEnergy));
  const cpuUsed = finiteNonnegative(input.cpuUsed);
  return deepFreeze({
    state: {
      schemaVersion: STATIC_MINING_TELEMETRY_SCHEMA_VERSION,
      sources: nextSamples,
    },
    telemetry: {
      schemaVersion: STATIC_MINING_TELEMETRY_SCHEMA_VERSION,
      observedSources: sources.length,
      droppedSources: Math.max(
        0,
        normalizeObservations(input.observations).length - sources.length,
      ),
      sourceUptimeTicks: total(sources.map(({ sourceUptimeTicks }) => sourceUptimeTicks)),
      harvestedEnergy,
      wastedEnergy: total(sources.map(({ wastedEnergy }) => wastedEnergy)),
      minerIdleTicks: total(sources.map(({ minerIdleTicks }) => minerIdleTicks)),
      replacementGapTicks: total(sources.map(({ replacementGapTicks }) => replacementGapTicks)),
      cpuUsed,
      cpuPerHarvestedEnergy: harvestedEnergy === 0 ? null : cpuUsed / harvestedEnergy,
      sources,
    },
  });
}

function normalizeObservations(
  values: readonly StaticMiningSourceObservation[],
): StaticMiningSourceObservation[] {
  const sorted = values
    .map(normalizeObservation)
    .sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        observationKey(left).localeCompare(observationKey(right)),
    );
  return sorted.filter(
    (value, index) => index === 0 || sorted[index - 1]?.sourceId !== value.sourceId,
  );
}

function normalizeObservation(value: StaticMiningSourceObservation): StaticMiningSourceObservation {
  if (
    typeof value.sourceId !== "string" ||
    value.sourceId.length === 0 ||
    value.sourceId.length > 128
  )
    throw new TypeError("static mining telemetry sourceId is invalid");
  const energyCapacity = safeInteger(value.energyCapacity);
  const energy = Math.min(energyCapacity, safeInteger(value.energy));
  const ticksToRegeneration = nullableInteger(value.ticksToRegeneration);
  const container =
    value.container === null
      ? null
      : {
          capacity: safeInteger(value.container.capacity),
          used: Math.min(safeInteger(value.container.capacity), safeInteger(value.container.used)),
          ticksToDecay: nullableInteger(value.container.ticksToDecay),
        };
  return { ...value, energy, energyCapacity, ticksToRegeneration, container };
}

function normalizePrevious(
  value: StaticMiningTelemetryState | null | undefined,
): ReadonlyMap<string, StaticMiningSourceSample> {
  if (value?.schemaVersion !== STATIC_MINING_TELEMETRY_SCHEMA_VERSION) return new Map();
  const samples = [...value.sources]
    .slice(0, MAX_STATIC_MINING_TELEMETRY_SOURCES)
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return new Map(
    samples.map((sample) => [
      sample.sourceId,
      {
        sourceId: sample.sourceId,
        energy: safeInteger(sample.energy),
        energyCapacity: safeInteger(sample.energyCapacity),
        observedAt: safeInteger(sample.observedAt),
        ticksToRegeneration: nullableInteger(sample.ticksToRegeneration),
      },
    ]),
  );
}

function energyDeltas(
  previous: StaticMiningSourceSample | undefined,
  current: StaticMiningSourceObservation,
  tick: number,
): { readonly harvested: number; readonly wasted: number } {
  if (previous === undefined || previous.observedAt >= tick) return { harvested: 0, wasted: 0 };
  const regenerated =
    previous.ticksToRegeneration !== null &&
    current.ticksToRegeneration !== null &&
    current.ticksToRegeneration > previous.ticksToRegeneration;
  return regenerated
    ? {
        harvested: Math.max(0, current.energyCapacity - current.energy),
        wasted: Math.min(previous.energy, current.energyCapacity),
      }
    : { harvested: Math.max(0, previous.energy - current.energy), wasted: 0 };
}

function observationKey(value: StaticMiningSourceObservation): string {
  return JSON.stringify(value);
}
function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("static mining telemetry requires a nonnegative safe integer");
  return value;
}
function nullableInteger(value: number | null): number | null {
  return value === null ? null : safeInteger(value);
}
function finiteNonnegative(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError("static mining telemetry CPU must be finite and nonnegative");
  return value;
}
function total(values: readonly number[]): number {
  return values.reduce((sum, value) => Math.min(Number.MAX_SAFE_INTEGER, sum + value), 0);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
