import { describe, expect, it } from "vitest";
import {
  COLONY_CAPABILITY_DOMAINS,
  COLONY_DOMAIN_HEALTH_DOMAINS,
  COLONY_RCL_POLICY_TABLE,
  isInfrastructureRecoveryAuthorized,
  projectColonyDomainHealth,
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
  rcl8Health: null,
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
  it("authorizes bounded infrastructure rebuilding without reopening optional progression", () => {
    const rclPolicy = projectColonyRclPolicy({ ...BASE, controllerLevel: 8 });
    const domainHealth = projectColonyDomainHealth({
      colonyId: "W1N1",
      statuses: [],
      tick: 100,
    });
    const colony = {
      activeThreat: false,
      controllerRisk: false,
      domainHealth,
      legalWorkforce: true,
      rclPolicy,
      state: "recovering" as const,
      visibility: "visible" as const,
    };

    expect(rclPolicy.progression.authorized).toBe(false);
    expect(isInfrastructureRecoveryAuthorized(colony)).toBe(true);
    expect(isInfrastructureRecoveryAuthorized({ ...colony, activeThreat: true })).toBe(false);
    expect(
      isInfrastructureRecoveryAuthorized({
        ...colony,
        rclPolicy: projectColonyRclPolicy({ ...BASE, controllerLevel: 8, energyAvailable: 299 }),
      }),
    ).toBe(false);
  });

  it("authorizes RCL2-RCL7 transitions and sustains RCL8 only with direct health", () => {
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

    const rcl8Health = projectColonyDomainHealth({
      colonyId: "W1N1",
      statuses: COLONY_DOMAIN_HEALTH_DOMAINS.map((domain) => ({
        colonyId: "W1N1",
        domain,
        observedAt: 100,
        status: "healthy" as const,
      })),
      tick: 100,
    });
    expect(projectColonyRclPolicy({ ...BASE, controllerLevel: 8, rcl8Health }).progression).toEqual(
      { status: "sustaining", authorized: true, reasonCode: "sustaining" },
    );
  });
});
