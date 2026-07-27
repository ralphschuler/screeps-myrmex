import type { RoutePolicyV1 } from "./contracts";

/** Immutable source policy. Operational Memory cannot broaden route safety or cost terms. */
export const DEFAULT_ROUTE_POLICY_V1: RoutePolicyV1 = deepFreeze({
  schemaVersion: 1,
  revision: "route-policy-v1",
  allowProtectedRooms: false,
  baseRoomCost: 1_000,
  highwayDiscount: 250,
  roadStepCost: 1,
  plainStepCost: 2,
  swampStepCost: 10,
  threatCostPerRisk: 100,
  relationCosts: {
    self: 0,
    ally: 0,
    nap: 0,
    neutral: 100,
    trespasser: 500,
    hostile: 2_000,
    war: 4_000,
  },
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
