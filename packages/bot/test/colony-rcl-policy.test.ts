import { describe, expect, it } from "vitest";
import {
  COLONY_CAPABILITY_DOMAINS,
  COLONY_RCL_POLICY_TABLE,
  projectColonyRclPolicy,
  type ColonyRclPolicyObservation,
} from "../src/colony";
const BASE: ColonyRclPolicyObservation = Object.freeze({
  visibility: "visible",
  state: "developing",
  controllerLevel: 2,
  energyAvailable: 12900,
  energyCapacityAvailable: 12900,
  activeThreat: false,
  controllerRisk: false,
  cpuMode: "normal",
  protectedSpawnEnergy: 300,
});
describe("complete-colony RCL policy projection", () => {
  it("publishes the exact table and bounded canonical domain order", () => {
    expect(
      COLONY_RCL_POLICY_TABLE.map(({ level, spawnPoolCapacityTarget }) => [
        level,
        spawnPoolCapacityTarget,
      ]),
    ).toEqual([
      [2, 550],
      [3, 800],
      [4, 1300],
      [5, 1800],
      [6, 2300],
      [7, 5600],
      [8, 12900],
    ]);
    for (const policyRow of COLONY_RCL_POLICY_TABLE) {
      const p = projectColonyRclPolicy({ ...BASE, controllerLevel: policyRow.level });
      expect(p.unlocks).toEqual(policyRow.unlocks);
      expect(p.domains.map(({ domain }) => domain)).toEqual(COLONY_CAPABILITY_DOMAINS);
      expect(p.domains).toHaveLength(8);
      expect(Object.isFrozen(p.domains)).toBe(true);
    }
  });
  it("is reset and reordering deterministic", () => {
    const a = projectColonyRclPolicy({
      ...BASE,
      controllerLevel: 7,
      energyAvailable: 300,
      energyCapacityAvailable: 5600,
    });
    const b = projectColonyRclPolicy(
      JSON.parse(
        JSON.stringify({
          protectedSpawnEnergy: 300,
          cpuMode: "normal",
          controllerRisk: false,
          activeThreat: false,
          energyCapacityAvailable: 5600,
          energyAvailable: 300,
          controllerLevel: 7,
          state: "developing",
          visibility: "visible",
        }),
      ) as ColonyRclPolicyObservation,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("applies declared fail-closed precedence", () => {
    const cases: readonly [Partial<ColonyRclPolicyObservation>, string][] = [
      [{ visibility: "unknown" }, "observation-unknown"],
      [{ state: "lost" }, "colony-lost"],
      [{ controllerLevel: 1 }, "outside-rcl2-rcl8"],
      [{ activeThreat: true }, "threat-preemption"],
      [{ state: "recovering" }, "recovery-preemption"],
      [{ state: "bootstrapping" }, "bootstrap-preemption"],
      [{ cpuMode: "constrained" }, "constrained-cpu-preemption"],
      [{ controllerRisk: true }, "controller-downgrade-risk"],
      [{ energyAvailable: 299 }, "protected-spawn-reserve-unrestored"],
      [{ energyCapacityAvailable: 549 }, "spawn-pool-capacity-below-target"],
    ];
    for (const [change, reasonCode] of cases)
      expect(projectColonyRclPolicy({ ...BASE, ...change }).progression).toMatchObject({
        authorized: false,
        reasonCode,
      });
  });
  it("authorizes RCL2-RCL7 transitions but not RCL8 maturity", () => {
    for (const policyRow of COLONY_RCL_POLICY_TABLE.slice(0, -1))
      expect(
        projectColonyRclPolicy({
          ...BASE,
          controllerLevel: policyRow.level,
          energyCapacityAvailable: policyRow.spawnPoolCapacityTarget,
        }).progression.reasonCode,
      ).toBe("active");
    expect(projectColonyRclPolicy({ ...BASE, controllerLevel: 8 }).progression).toEqual({
      status: "blocked",
      authorized: false,
      reasonCode: "rcl8-health-evidence-unavailable",
    });
  });
});
