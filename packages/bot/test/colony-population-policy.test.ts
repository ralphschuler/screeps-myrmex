import { describe, expect, it } from "vitest";
import {
  ColonyPopulationPolicy,
  MAX_POPULATION_DEMANDS,
  type ColonyPopulationPolicyInput,
} from "../src/colony";
import {
  CAPABILITY_KEYS,
  type CapabilityVector,
  type NormalizedPopulationLoad,
  type WorkforceActor,
} from "../src/contracts";
const WCM: CapabilityVector = {
  attack: 0,
  carry: 1,
  claim: 0,
  heal: 0,
  move: 1,
  rangedAttack: 0,
  tough: 0,
  work: 1,
};
const load = (change: Partial<NormalizedPopulationLoad> = {}): NormalizedPopulationLoad => ({
  backlogWorkTicks: 20,
  category: "harvesting-filling",
  colonyId: "W1N1",
  contractId: "contract-1",
  measuredWorkTicks: 40,
  minimumCapability: WCM,
  objectiveId: "objective-1",
  reservationId: "reservation-1",
  revision: 1,
  sourceCapacityWorkTicks: 50,
  travelTicks: 10,
  ...change,
});
const input = (change: Partial<ColonyPopulationPolicyInput> = {}): ColonyPopulationPolicyInput => ({
  activeThreat: false,
  actors: [],
  availableEnergy: 2_000,
  colonyId: "W1N1",
  committedDemandIds: [],
  controllerRisk: false,
  cpuMode: "normal",
  funded: { loads: [load()], status: "ready" },
  maximumBodyEnergy: 3_000,
  protectedSpawnEnergy: 300,
  replacementLeadTicks: 59,
  spawnUtilizationBasisPoints: 0,
  state: "developing",
  visibility: "visible",
  ...change,
});
const actor = (ttl: number): WorkforceActor => ({
  capability: WCM,
  id: "actor-1",
  name: "worker",
  pos: { roomName: "W1N1", x: 10, y: 10 },
  spawning: false,
  ticksToLive: ttl,
});
describe("ColonyPopulationPolicy", () => {
  it("uses exact normalized formula", () => {
    const result = new ColonyPopulationPolicy().project(input());
    expect(result.targetCapability).toMatchObject({ work: 2, carry: 2, move: 2 });
    expect(result.demands).toHaveLength(2);
  });
  it("is reset and reorder byte deterministic", () => {
    const a = input({
      funded: {
        status: "ready",
        loads: [
          load({ objectiveId: "b" }),
          load({ objectiveId: "a", contractId: "c2", reservationId: "r2" }),
        ],
      },
    });
    const b = { ...a, funded: { status: "ready" as const, loads: [...a.funded.loads].reverse() } };
    expect(JSON.stringify(new ColonyPopulationPolicy().project(a))).toBe(
      JSON.stringify(
        new ColonyPopulationPolicy().project(
          JSON.parse(JSON.stringify(b)) as ColonyPopulationPolicyInput,
        ),
      ),
    );
  });
  it("fails closed for unknown lost and unfunded", () => {
    const p = new ColonyPopulationPolicy();
    expect(p.project(input({ visibility: "unknown" })).reasonCode).toBe("observation-unknown");
    expect(p.project(input({ state: "lost" })).reasonCode).toBe("colony-lost");
    expect(p.project(input({ funded: { loads: [], status: "unavailable" } })).demands).toEqual([]);
  });
  it("preempts optional but preserves defense", () => {
    const p = new ColonyPopulationPolicy();
    const optional = load({ category: "optional-growth" });
    for (const change of [
      { activeThreat: true },
      { state: "recovering" as const },
      { state: "bootstrapping" as const },
      { cpuMode: "constrained" as const },
      { controllerRisk: true },
      { spawnUtilizationBasisPoints: 9_000 },
    ])
      expect(
        p.project(input({ ...change, funded: { loads: [optional], status: "ready" } })).demands,
      ).toEqual([]);
    const mixed = p.project(
      input({
        activeThreat: true,
        funded: {
          status: "ready",
          loads: [
            optional,
            load({
              category: "defense",
              objectiveId: "defense",
              contractId: "d",
              reservationId: "d",
            }),
          ],
        },
      }),
    );
    expect(mixed.demands.every(({ category }) => category === "defense")).toBe(true);
  });
  it("uses exact replacement lead edge", () => {
    const p = new ColonyPopulationPolicy();
    expect(p.project(input({ actors: [actor(59)] })).demands).toHaveLength(2);
    expect(p.project(input({ actors: [actor(60)] })).demands).toHaveLength(1);
  });
  it("suppresses duplicate unaffordable and reserve violations", () => {
    const p = new ColonyPopulationPolicy();
    const first = p.project(input());
    expect(
      p.project(input({ committedDemandIds: [first.demands[0]?.id ?? ""] })).demands,
    ).toHaveLength(1);
    expect(p.project(input({ availableEnergy: 199 })).demands).toEqual([]);
    expect(p.project(input({ availableEnergy: 499 })).reasonCode).toBe("protected-spawn-reserve");
    expect(p.project(input({ availableEnergy: 500 })).demands).toHaveLength(1);
  });
  it("enforces all hard bounds", () => {
    const loads = Array.from({ length: 80 }, (_, index) =>
      load({
        objectiveId: `o-${String(index)}`,
        contractId: `c-${String(index)}`,
        reservationId: `r-${String(index)}`,
        measuredWorkTicks: 10_000,
        backlogWorkTicks: 10_000,
        sourceCapacityWorkTicks: 10_000,
        travelTicks: 10_000,
      }),
    );
    const result = new ColonyPopulationPolicy().project(
      input({ availableEnergy: 100_000, funded: { loads, status: "ready" } }),
    );
    expect(result.demands).toHaveLength(MAX_POPULATION_DEMANDS);
    expect(result.truncatedObjectives).toBe(16);
    expect(
      CAPABILITY_KEYS.reduce((sum, key) => sum + result.targetCapability[key], 0),
    ).toBeLessThanOrEqual(256);
  });
});
