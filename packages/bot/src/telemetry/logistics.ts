export const LOGISTICS_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const MAX_LOGISTICS_TELEMETRY_FLOWS = 64 as const;

/**
 * Cumulative, immutable lifecycle facts for one stable logistics flow. Runtime supplies these only
 * after planning, funding, and command settlement; telemetry never authorizes gameplay.
 */
export interface LogisticsFlowObservation {
  readonly flowId: string;
  readonly contractId: string | null;
  readonly requested: number;
  readonly scheduled: number;
  readonly pickedUp: number;
  readonly delivered: number;
  readonly loss: number;
  readonly firstRequestedAt: number;
  readonly active: boolean;
}

export interface LogisticsFlowSample extends LogisticsFlowObservation {
  readonly observedAt: number;
}

export interface LogisticsTelemetryState {
  readonly schemaVersion: typeof LOGISTICS_TELEMETRY_SCHEMA_VERSION;
  readonly flows: readonly LogisticsFlowSample[];
}

export interface LogisticsFlowTelemetry {
  readonly flowId: string;
  readonly contractId: string | null;
  readonly requested: number;
  readonly scheduled: number;
  readonly pickedUp: number;
  readonly delivered: number;
  readonly shortfall: number;
  readonly loss: number;
  readonly latencyTicks: number | null;
  readonly active: boolean;
}

export interface LogisticsTelemetry {
  readonly schemaVersion: typeof LOGISTICS_TELEMETRY_SCHEMA_VERSION;
  readonly observedFlows: number;
  readonly droppedFlows: number;
  readonly activeFlows: number;
  readonly activeContracts: number;
  readonly requested: number;
  readonly scheduled: number;
  readonly pickedUp: number;
  readonly delivered: number;
  readonly shortfall: number;
  readonly loss: number;
  /** Delivered-amount-weighted latency for delivery progress observed on this tick. */
  readonly latencyTicks: number | null;
  readonly cpuUsed: number;
  readonly flows: readonly LogisticsFlowTelemetry[];
}

export interface LogisticsTelemetryReduction {
  readonly state: LogisticsTelemetryState;
  readonly telemetry: LogisticsTelemetry;
}

export function reduceLogisticsTelemetry(input: {
  readonly tick: number;
  readonly cpuUsed: number;
  readonly observations: readonly LogisticsFlowObservation[];
  readonly previous?: LogisticsTelemetryState | null;
  readonly maximumFlows?: number;
}): LogisticsTelemetryReduction {
  const tick = safeInteger(input.tick);
  const cpuUsed = finiteNonnegative(input.cpuUsed);
  const limit = Math.min(
    MAX_LOGISTICS_TELEMETRY_FLOWS,
    input.maximumFlows === undefined
      ? MAX_LOGISTICS_TELEMETRY_FLOWS
      : safeInteger(input.maximumFlows),
  );
  const normalized = normalizeObservations(input.observations);
  const observations = normalized.slice(0, limit);
  const previous = normalizePrevious(input.previous);
  const nextSamples: LogisticsFlowSample[] = [];
  const flows = observations.map((observation): LogisticsFlowTelemetry => {
    const prior = previous.get(observation.flowId);
    const advances = lifecycleAdvances(prior, observation, tick);
    nextSamples.push({ ...observation, observedAt: tick });
    return Object.freeze({
      flowId: observation.flowId,
      contractId: observation.contractId,
      requested: observation.requested,
      scheduled: observation.scheduled,
      pickedUp: advances.pickedUp,
      delivered: advances.delivered,
      shortfall: Math.max(0, observation.requested - observation.scheduled),
      loss: advances.loss,
      latencyTicks:
        advances.delivered === 0 ? null : Math.max(0, tick - observation.firstRequestedAt),
      active: observation.active,
    });
  });
  const delivered = total(flows.map((flow) => flow.delivered));
  const weightedLatency = flows.reduce(
    (sum, flow) => (flow.latencyTicks === null ? sum : sum + flow.latencyTicks * flow.delivered),
    0,
  );
  return deepFreeze({
    state: {
      schemaVersion: LOGISTICS_TELEMETRY_SCHEMA_VERSION,
      flows: nextSamples,
    },
    telemetry: {
      schemaVersion: LOGISTICS_TELEMETRY_SCHEMA_VERSION,
      observedFlows: flows.length,
      droppedFlows: Math.max(0, normalized.length - flows.length),
      activeFlows: flows.filter(({ active }) => active).length,
      activeContracts: new Set(
        flows.flatMap(({ active, contractId }) =>
          active && contractId !== null ? [contractId] : [],
        ),
      ).size,
      requested: total(flows.map((flow) => flow.requested)),
      scheduled: total(flows.map((flow) => flow.scheduled)),
      pickedUp: total(flows.map((flow) => flow.pickedUp)),
      delivered,
      shortfall: total(flows.map((flow) => flow.shortfall)),
      loss: total(flows.map((flow) => flow.loss)),
      latencyTicks: delivered === 0 ? null : weightedLatency / delivered,
      cpuUsed,
      flows,
    },
  });
}

function normalizeObservations(
  values: readonly LogisticsFlowObservation[],
): LogisticsFlowObservation[] {
  const sorted = values
    .map(normalizeObservation)
    .sort(
      (left, right) =>
        left.flowId.localeCompare(right.flowId) ||
        observationKey(left).localeCompare(observationKey(right)),
    );
  return sorted.filter((value, index) => index === 0 || sorted[index - 1]?.flowId !== value.flowId);
}

function normalizeObservation(value: LogisticsFlowObservation): LogisticsFlowObservation {
  assertId(value.flowId, "flowId");
  if (value.contractId !== null) assertId(value.contractId, "contractId");
  return {
    flowId: value.flowId,
    contractId: value.contractId,
    requested: safeInteger(value.requested),
    scheduled: safeInteger(value.scheduled),
    pickedUp: safeInteger(value.pickedUp),
    delivered: safeInteger(value.delivered),
    loss: safeInteger(value.loss),
    firstRequestedAt: safeInteger(value.firstRequestedAt),
    active: value.active,
  };
}

function normalizePrevious(
  value: LogisticsTelemetryState | null | undefined,
): ReadonlyMap<string, LogisticsFlowSample> {
  if (value?.schemaVersion !== LOGISTICS_TELEMETRY_SCHEMA_VERSION) return new Map();
  const samples = [...value.flows]
    .slice(0, MAX_LOGISTICS_TELEMETRY_FLOWS)
    .map((sample) => ({
      ...normalizeObservation(sample),
      observedAt: safeInteger(sample.observedAt),
    }))
    .sort((left, right) => left.flowId.localeCompare(right.flowId));
  return new Map(samples.map((sample) => [sample.flowId, sample]));
}

function lifecycleAdvances(
  previous: LogisticsFlowSample | undefined,
  current: LogisticsFlowObservation,
  tick: number,
): { readonly pickedUp: number; readonly delivered: number; readonly loss: number } {
  if (previous === undefined || previous.observedAt >= tick) {
    return { pickedUp: 0, delivered: 0, loss: 0 };
  }
  return {
    pickedUp: Math.max(0, current.pickedUp - previous.pickedUp),
    delivered: Math.max(0, current.delivered - previous.delivered),
    loss: Math.max(0, current.loss - previous.loss),
  };
}

function observationKey(value: LogisticsFlowObservation): string {
  return JSON.stringify(value);
}

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new TypeError(`logistics telemetry ${name} is invalid`);
}

function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("logistics telemetry requires a nonnegative safe integer");
  return value;
}

function finiteNonnegative(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError("logistics telemetry CPU must be finite and nonnegative");
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
