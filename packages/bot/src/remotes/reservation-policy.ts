import type { RemoteReservationPolicyV1 } from "./reservation-contracts";

/** Source-owned reservation economics. Operational Memory cannot broaden these terms. */
export const DEFAULT_REMOTE_RESERVATION_POLICY_V1: RemoteReservationPolicyV1 = deepFreeze({
  schemaVersion: 1,
  revision: "remote-reservation-policy-v1",
  claimParts: 2,
  moveParts: 2,
  claimPartEnergy: 600,
  movePartEnergy: 50,
  spawnTicksPerPart: 3,
  claimCreepLifetime: 600,
  reservationTargetTicks: 450,
  replacementSafetyTicks: 25,
  cpuMilli: 100,
  maximumThreatRisk: 0,
  maximumIntelAgeTicks: 25,
  maximumCommandAttempts: 3,
  retryInitialDelayTicks: 2,
  retryMaximumDelayTicks: 16,
  signText: "MYRMEX",
});
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
