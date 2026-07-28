import type { RemoteAccountingPolicyV1 } from "./accounting-contracts";

/** Strategic shadow prices are source policy, not remembered engine mechanics. */
export const DEFAULT_REMOTE_ACCOUNTING_POLICY_V1: RemoteAccountingPolicyV1 = Object.freeze({
  schemaVersion: 1,
  revision: "remote-accounting-policy-v1",
  windowTicks: 50,
  maximumSamplesPerRemote: 50,
  minimumCompleteTicks: 10,
  minimumConfidenceBasisPoints: 8_000,
  staleAfterTicks: 2,
  minimumProfitMilliPerTick: 1,
  marginalProfitMilliPerTick: 1_000,
  spawnTimeCostMilliEnergyPerTick: 100,
  travelCostMilliEnergyPerTick: 50,
  cpuCostMilliEnergyPerMilliCpu: 2,
});
