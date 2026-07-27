import type { RemoteMiningPolicyV1 } from "./mining-contracts";

export const DEFAULT_REMOTE_MINING_POLICY_V1: RemoteMiningPolicyV1 = deepFreeze({
  schemaVersion: 1,
  revision: "remote-mining-policy-v1",
  sourceRegenerationTicks: 300,
  harvestPower: 2,
  maximumSourceEnergyCapacity: 3_000,
  workPartEnergy: 100,
  movePartEnergy: 50,
  spawnTicksPerPart: 3,
  creepLifetime: 1_500,
  replacementSafetyTicks: 25,
  minimumOperatingTicks: 300,
  cpuMilliPerSource: 50,
  memoryCodeUnitsPerSource: 1_024,
  maximumIntelAgeTicks: 25,
  maximumThreatRisk: 0,
  maximumCommandAttempts: 3,
  retryInitialDelayTicks: 2,
  retryMaximumDelayTicks: 32,
  containerBuildEnergy: 5_000,
  containerUpkeepMilliEnergyPerTick: 500,
  infrastructureCpuMilli: 25,
  roadPlainBuildEnergy: 300,
  roadSwampBuildEnergy: 1_500,
  roadFatigueValueMilliEnergy: 1,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
