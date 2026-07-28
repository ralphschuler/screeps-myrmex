import type { RemoteSafetyPolicyV1 } from "./safety-contracts";

/** Source-owned fail-closed operational remote-safety policy. */
export const DEFAULT_REMOTE_SAFETY_POLICY_V1: RemoteSafetyPolicyV1 = deepFreeze({
  schemaVersion: 1,
  revision: "remote-safety-policy-v1",
  assessmentCpuMilli: 25,
  evacuationMovementPriority: 10_000,
  maximumIntelAgeTicks: 5,
  maximumRecentLossBasisPoints: 2_500,
  minimumConfidenceBasisPoints: 8_000,
  invaderCoreDeploymentLeadTicks: 100,
  threatRisk: 1,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
