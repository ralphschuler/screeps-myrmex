import type { RemotePortfolioPolicyV1 } from "./contracts";

/** Immutable source policy. Operational Memory cannot broaden remote admission. */
export const DEFAULT_REMOTE_PORTFOLIO_POLICY_V1: RemotePortfolioPolicyV1 = deepFreeze({
  schemaVersion: 1,
  revision: "remote-portfolio-policy-v1",
  minimumProfitMilliPerTick: 1,
  activeRetentionBonusMilliPerTick: 1_000,
  maximumThreatRisk: 0,
  probingTicks: 2,
  suspensionCooldownTicks: 3,
  resumptionProbeTicks: 2,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
