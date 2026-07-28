export const REMOTE_ACCOUNTING_SCHEMA_VERSION = 1 as const;

export const REMOTE_ACCOUNTING_LIMITS = Object.freeze({
  maximumIdentityCodeUnits: 128,
  maximumObservationsPerTick: 8,
  maximumRecords: 8,
  maximumSamplesPerRemote: 50,
  maximumValuePerTick: 1_000_000_000,
  maximumWindowTicks: 1_000,
} as const);

export type RemoteAccountingQuality = "complete" | "partial";
export type RemoteAccountingReason =
  "warming-up" | "profitable" | "marginal" | "loss-making" | "stale" | "incomplete";

/** Detached settled values for one remote and tick. Fields are disjoint attribution categories. */
export interface RemoteAccountingObservation {
  readonly roomName: string;
  readonly donorColonyId: string;
  readonly observedAt: number;
  readonly quality: RemoteAccountingQuality;
  readonly harvestedEnergy: number;
  readonly deliveredEnergy: number;
  readonly spawnEnergy: number;
  readonly spawnTicks: number;
  readonly travelTicks: number;
  readonly reservationEnergy: number;
  readonly constructionEnergy: number;
  readonly repairEnergy: number;
  readonly cpuMilli: number;
  readonly creepLossEnergy: number;
  readonly downtimeTicks: number;
  readonly forecastRevenueMilliPerTick: number;
  readonly forecastProfitMilliPerTick: number;
}

export interface RemoteAccountingPolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly windowTicks: number;
  readonly maximumSamplesPerRemote: number;
  readonly minimumCompleteTicks: number;
  readonly minimumConfidenceBasisPoints: number;
  readonly staleAfterTicks: number;
  readonly minimumProfitMilliPerTick: number;
  readonly marginalProfitMilliPerTick: number;
  readonly spawnTimeCostMilliEnergyPerTick: number;
  readonly travelCostMilliEnergyPerTick: number;
  readonly cpuCostMilliEnergyPerMilliCpu: number;
}

/**
 * Compact persistent sample owned by RemotePortfolio.
 *
 * [tick, complete, harvested, delivered, spawn energy, spawn ticks, travel ticks,
 * reservation energy, construction energy, repair energy, CPU milli, creep-loss energy,
 * downtime ticks, forecast revenue milli/tick, forecast profit milli/tick]
 */
export type RemoteAccountingSampleV1 = readonly [
  tick: number,
  complete: 0 | 1,
  harvestedEnergy: number,
  deliveredEnergy: number,
  spawnEnergy: number,
  spawnTicks: number,
  travelTicks: number,
  reservationEnergy: number,
  constructionEnergy: number,
  repairEnergy: number,
  cpuMilli: number,
  creepLossEnergy: number,
  downtimeTicks: number,
  forecastRevenueMilliPerTick: number,
  forecastProfitMilliPerTick: number,
];

export interface RemoteAccountingRecordV1 {
  readonly roomName: string;
  readonly donorColonyId: string;
  readonly samples: readonly RemoteAccountingSampleV1[];
}

export interface RemoteRealizedCosts {
  readonly spawnEnergyMilli: number;
  readonly spawnTimeMilli: number;
  readonly travelMilli: number;
  readonly reservationMilli: number;
  readonly constructionMilli: number;
  readonly repairMilli: number;
  readonly cpuMilli: number;
  readonly creepLossMilli: number;
  readonly downtimeMilli: number;
  readonly totalMilli: number;
}

export interface RemoteProfitabilitySummary {
  readonly roomName: string;
  readonly donorColonyId: string;
  readonly windowStartTick: number;
  readonly windowEndTick: number;
  readonly sampleTicks: number;
  readonly completeTicks: number;
  readonly confidenceBasisPoints: number;
  readonly harvestedEnergy: number;
  readonly deliveredEnergy: number;
  readonly downtimeTicks: number;
  readonly forecastProfitMilliPerTick: number;
  readonly costs: RemoteRealizedCosts;
  readonly revenueMilli: number;
  readonly profitMilli: number;
  readonly profitMilliPerTick: number;
  readonly forecastVarianceMilliPerTick: number;
  readonly utilizationBasisPoints: number;
  readonly reason: RemoteAccountingReason;
}

export interface RemoteAccountingMetrics {
  readonly observed: number;
  readonly tracked: number;
  readonly warmingUp: number;
  readonly profitable: number;
  readonly marginal: number;
  readonly lossMaking: number;
  readonly stale: number;
  readonly incomplete: number;
  readonly revenueMilli: number;
  readonly costMilli: number;
  readonly profitMilli: number;
  readonly harvestedEnergy: number;
  readonly deliveredEnergy: number;
  readonly downtimeTicks: number;
}

export type RemoteAccountingStatus = "ready" | "invalid-input" | "limit-exceeded";

export interface RemoteAccountingResult {
  readonly status: RemoteAccountingStatus;
  readonly changed: boolean;
  readonly records: readonly RemoteAccountingRecordV1[];
  readonly summaries: readonly RemoteProfitabilitySummary[];
  readonly metrics: RemoteAccountingMetrics;
}
