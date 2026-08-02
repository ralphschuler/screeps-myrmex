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
  controllerLevel: 2,
  controllerRisk: false,
  cpuMode: "normal",
  energyCapacityAvailable: 3_000,
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
  it("admits optional RCL2 population without opening mature surplus population", () => {
    const optional = load({ category: "optional-growth" });
    const policy = new ColonyPopulationPolicy();
    expect(
      policy.project(
        input({
          controllerLevel: 2,
          cpuMode: "surplus",
          funded: { loads: [optional], status: "ready" },
        }),
      ).demands,
    ).not.toEqual([]);
    expect(
      policy.project(
        input({
          controllerLevel: 8,
          cpuMode: "surplus",
          funded: { loads: [optional], status: "ready" },
        }),
      ).demands,
    ).toEqual([]);
  });

  it("uses exact replacement lead edge", () => {
    const p = new ColonyPopulationPolicy();
    expect(p.project(input({ actors: [actor(59)] })).demands).toHaveLength(2);
    expect(p.project(input({ actors: [actor(60)] })).demands).toHaveLength(1);
  });
  it("uses only executable spawn and busy time at the stationary replacement edge", () => {
    const p = new ColonyPopulationPolicy();
    const stationary = input({
      funded: { loads: [load({ mode: "stationary" })], status: "ready" },
      spawnBusyTicks: 5,
    });
    // replacement lead 59 + WCM spawn time 9 + current busy time 5 = 73
    expect(p.project({ ...stationary, actors: [actor(73)] }).demands).toHaveLength(1);
    expect(p.project({ ...stationary, actors: [actor(74)] }).demands).toEqual([]);
  });
  it("does not turn a stationary feasibility horizon into idle successor lead time", () => {
    const required = { ...WCM, move: 2, work: 2 };
    const stationary = input({
      funded: {
        loads: [
          load({
            minimumCapability: required,
            mode: "stationary",
            travelTicks: 1_500,
          }),
        ],
        status: "ready",
      },
    });
    const worker = (ticksToLive: number): WorkforceActor => ({
      ...actor(ticksToLive),
      capability: required,
    });
    // replacement 59 + five-part spawn 15 = 74
    expect(
      new ColonyPopulationPolicy().project({ ...stationary, actors: [worker(74)] }).demands,
    ).toHaveLength(1);
    expect(
      new ColonyPopulationPolicy().project({ ...stationary, actors: [worker(75)] }).demands,
    ).toEqual([]);
  });
  it("keeps one distant stationary successor fresh through the sole-lease handoff", () => {
    const required = { ...WCM, carry: 0, move: 1, work: 5 };
    const stationary = input({
      funded: {
        loads: [
          load({
            minimumCapability: required,
            mode: "stationary",
            travelTicks: 1_250,
          }),
        ],
        status: "ready",
      },
    });
    const miner = (id: string, ticksToLive: number): WorkforceActor => ({
      ...actor(ticksToLive),
      capability: required,
      id,
      name: id,
    });
    // replacement 59 + six-part spawn 18 = 77; the successor cannot move before handoff.
    expect(
      new ColonyPopulationPolicy().project({ ...stationary, actors: [miner("miner", 77)] }).demands,
    ).toHaveLength(1);
    expect(
      new ColonyPopulationPolicy().project({
        ...stationary,
        actors: [miner("miner", 59), miner("successor", 1_441)],
      }).demands,
    ).toEqual([]);
    expect(
      new ColonyPopulationPolicy().project({
        ...stationary,
        actors: [miner("successor", 1_382)],
      }).demands,
    ).toEqual([]);
  });
  it("keeps one stable stationary demand identity across death, expiry, reset, and commitment", () => {
    const p = new ColonyPopulationPolicy();
    const stationary = input({
      funded: { loads: [load({ mode: "stationary" })], status: "ready" },
    });
    expect(p.project({ ...stationary, actors: [actor(69)] }).demands).toEqual([]);
    const expired = p.project({ ...stationary, actors: [actor(68)] });
    const dead = p.project({ ...stationary, actors: [] });
    const reset = new ColonyPopulationPolicy().project(
      JSON.parse(JSON.stringify({ ...stationary, actors: [] })) as ColonyPopulationPolicyInput,
    );
    expect(expired.demands).toHaveLength(1);
    expect(dead.demands.map(({ id }) => id)).toEqual(expired.demands.map(({ id }) => id));
    expect(reset.demands.map(({ id }) => id)).toEqual(dead.demands.map(({ id }) => id));
    expect(
      p.project({
        ...stationary,
        actors: [],
        committedDemandIds: dead.demands.map(({ id }) => id),
      }).demands,
    ).toEqual([]);
  });
  it("does not count one actor for two stationary source loads", () => {
    const stationary = input({
      actors: [actor(500)],
      funded: {
        loads: [
          load({ mode: "stationary", objectiveId: "source/a" }),
          load({
            contractId: "contract-b",
            mode: "stationary",
            objectiveId: "source/b",
            reservationId: "reservation-b",
          }),
        ],
        status: "ready",
      },
    });
    const projected = new ColonyPopulationPolicy().project(stationary);
    expect(projected.demands).toHaveLength(1);
    expect(projected.demands[0]?.objectiveId).toBe("source/b");
  });

  it("does not reuse ordinary-work supply for a later stationary load", () => {
    const projected = new ColonyPopulationPolicy().project(
      input({
        actors: [actor(500)],
        funded: {
          loads: [
            load({
              backlogWorkTicks: 0,
              measuredWorkTicks: 50,
              objectiveId: "ordinary/a",
              sourceCapacityWorkTicks: 50,
              travelTicks: 0,
            }),
            load({
              contractId: "contract-b",
              mode: "stationary",
              objectiveId: "source/b",
              reservationId: "reservation-b",
            }),
          ],
          status: "ready",
        },
      }),
    );
    expect(projected.demands).toHaveLength(1);
    expect(projected.demands[0]?.objectiveId).toBe("source/b");
  });

  it("keeps each logistics flow slot to one convergent replacement demand", () => {
    const logistics = input({
      funded: {
        loads: [
          load({
            mode: "logistics",
            objectiveId: "flow/slot/0",
            minimumCapability: { ...WCM, work: 0 },
          }),
        ],
        status: "ready",
      },
    });
    const dead = new ColonyPopulationPolicy().project(logistics);
    expect(dead.demands).toHaveLength(1);
    expect(
      new ColonyPopulationPolicy()
        .project(JSON.parse(JSON.stringify(logistics)) as ColonyPopulationPolicyInput)
        .demands.map(({ id }) => id),
    ).toEqual(dead.demands.map(({ id }) => id));
    expect(
      new ColonyPopulationPolicy().project({
        ...logistics,
        actors: [{ ...actor(500), capability: { ...WCM, work: 0 } }],
      }).demands,
    ).toEqual([]);
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
  it("lets exactly one explicit RCL2 progression demand spend the protected reserve", () => {
    const policy = new ColonyPopulationPolicy();
    for (const objectiveId of [
      "growth/W1N1/build/extension-site-a",
      "growth/W1N1/rcl2-bootstrap/build/extension-site-a",
      "growth/W1N1/upgrade-controller/controller-a/slot/0",
    ]) {
      const projected = policy.project(
        input({
          availableEnergy: 599,
          funded: {
            loads: [load({ category: "optional-growth", objectiveId })],
            status: "ready",
          },
          protectedSpawnEnergy: 500,
        }),
      );

      expect(projected.targetCapability).toMatchObject({ carry: 2, move: 2, work: 2 });
      expect(projected.demands).toHaveLength(1);
      expect(projected.demands[0]?.objectiveId).toBe(objectiveId);
    }
    const minerCapability = { ...WCM, carry: 0, move: 1, work: 5 };
    const miners = policy.project(
      input({
        availableEnergy: 550,
        funded: {
          loads: [
            load({
              category: "harvesting-filling",
              minimumCapability: minerCapability,
              mode: "stationary",
              objectiveId: "mining/W1N1/source-a",
            }),
            load({
              category: "harvesting-filling",
              contractId: "contract-miner-b",
              minimumCapability: minerCapability,
              mode: "stationary",
              objectiveId: "mining/W1N1/source-b",
              reservationId: "reservation-miner-b",
            }),
          ],
          status: "ready",
        },
        maximumBodyEnergy: 550,
        protectedSpawnEnergy: 300,
      }),
    );
    expect(miners.demands).toEqual([
      expect.objectContaining({
        category: "harvesting-filling",
        objectiveId: "mining/W1N1/source-a",
        requiredCapability: minerCapability,
      }),
    ]);
    const protectedOnly = policy.project(
      input({
        availableEnergy: 300,
        funded: {
          loads: [
            load({
              category: "harvesting-filling",
              minimumCapability: { ...WCM, carry: 0, move: 1, work: 2 },
              mode: "stationary",
              objectiveId: "mining/W1N1/source-a",
            }),
          ],
          status: "ready",
        },
        maximumBodyEnergy: 300,
        protectedSpawnEnergy: 300,
      }),
    );
    expect(protectedOnly).toMatchObject({ demands: [], reasonCode: "protected-spawn-reserve" });
  });
  it("holds room energy for the first spawnable priority body instead of funding a cheaper lane", () => {
    const policy = new ColonyPopulationPolicy();
    const mining = load({
      category: "harvesting-filling",
      minimumCapability: { ...WCM, carry: 0, move: 1, work: 5 },
      mode: "stationary",
      objectiveId: "mining/W1N1/source-a",
    });
    const controllerLane = load({
      category: "optional-growth",
      contractId: "controller-slot",
      minimumCapability: { ...WCM, carry: 2, move: 2, work: 2 },
      objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/01",
      reservationId: "controller-slot-reservation",
    });

    const waiting = policy.project(
      input({
        availableEnergy: 400,
        energyCapacityAvailable: 550,
        funded: { loads: [controllerLane, mining], status: "ready" },
        maximumBodyEnergy: 550,
      }),
    );
    expect(waiting).toMatchObject({ demands: [], reasonCode: "insufficient-available-energy" });

    const funded = policy.project(
      input({
        availableEnergy: 550,
        energyCapacityAvailable: 550,
        funded: { loads: [controllerLane, mining], status: "ready" },
        maximumBodyEnergy: 550,
      }),
    );
    expect(funded.demands).toEqual([
      expect.objectContaining({ objectiveId: "mining/W1N1/source-a" }),
    ]);

    const capacityBound = policy.project(
      input({
        availableEnergy: 400,
        energyCapacityAvailable: 400,
        funded: { loads: [controllerLane, mining], status: "ready" },
        maximumBodyEnergy: 550,
      }),
    );
    expect(capacityBound.demands).toEqual([
      expect.objectContaining({ objectiveId: controllerLane.objectiveId }),
    ]);
  });
  it("keeps the RCL2 progression reserve exception exact and issuer-scoped", () => {
    const policy = new ColonyPopulationPolicy();
    const blockedObjectives = [
      "growth/W2N2/build/extension-site-a",
      "growth/W1N1/build",
      "growth/W1N1/rcl2-bootstrap/build",
      "growth/W1N1/rcl2-bootstrap/build/extension-site-a/extra",
      "growth/W1N1/upgrade-controller/controller-a",
      "growth/W1N1/upgrade-controller/controller-a/slot",
      "growth/W1N1/upgrade-controller/controller-a/slot/0/extra",
      "growth/W1N1/other/objective",
    ];
    for (const objectiveId of blockedObjectives) {
      expect(
        policy.project(
          input({
            availableEnergy: 499,
            funded: {
              loads: [load({ category: "optional-growth", objectiveId })],
              status: "ready",
            },
          }),
        ),
      ).toMatchObject({ demands: [], reasonCode: "protected-spawn-reserve" });
    }
    for (const objectiveId of [
      "mining/W2N2/source-a",
      "mining/W1N1",
      "mining/W1N1/source-a/extra",
    ]) {
      expect(
        policy.project(
          input({
            availableEnergy: 499,
            funded: {
              loads: [load({ category: "harvesting-filling", objectiveId })],
              status: "ready",
            },
          }),
        ),
      ).toMatchObject({ demands: [], reasonCode: "protected-spawn-reserve" });
    }
    expect(
      policy.project(
        input({
          availableEnergy: 499,
          controllerLevel: 3,
          funded: {
            loads: [
              load({
                category: "optional-growth",
                objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/0",
              }),
            ],
            status: "ready",
          },
        }),
      ),
    ).toMatchObject({ demands: [], reasonCode: "protected-spawn-reserve" });
    expect(
      policy.project(
        input({
          availableEnergy: 499,
          funded: {
            loads: [
              load({
                category: "maintenance",
                objectiveId: "growth/W1N1/build/extension-site-a",
              }),
            ],
            status: "ready",
          },
        }),
      ),
    ).toMatchObject({ demands: [], reasonCode: "protected-spawn-reserve" });
  });
  it("requires one actor to satisfy a multi-part contract capability", () => {
    const required = { ...WCM, carry: 2, move: 3, work: 3 };
    const fragmented = [
      { ...actor(500), id: "actor-a", name: "worker-a" },
      { ...actor(500), id: "actor-b", name: "worker-b" },
      { ...actor(500), id: "actor-c", name: "worker-c" },
    ];
    const projected = new ColonyPopulationPolicy().project(
      input({
        actors: fragmented,
        availableEnergy: 550,
        funded: {
          loads: [
            load({
              category: "optional-growth",
              minimumCapability: required,
              objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/01",
            }),
          ],
          status: "ready",
        },
        maximumBodyEnergy: 550,
      }),
    );

    expect(projected.targetCapability).toEqual(required);
    expect(projected.demands).toEqual([
      expect.objectContaining({ requiredCapability: required, energyCap: 550 }),
    ]);
    expect(
      new ColonyPopulationPolicy().project({
        ...input({
          funded: {
            loads: [
              load({
                category: "optional-growth",
                minimumCapability: required,
                objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/01",
              }),
            ],
            status: "ready",
          },
        }),
        actors: [{ ...actor(500), capability: required }],
      }).demands,
    ).toEqual([]);
  });
  it("reserves the least-surplus actor so a light slot cannot consume a heavy slot actor", () => {
    const heavy = { ...WCM, carry: 2, move: 3, work: 3 };
    const lightActor = { ...actor(500), id: "actor-z", name: "light" };
    const heavyActor = {
      ...actor(500),
      capability: heavy,
      id: "actor-a",
      name: "heavy",
    };
    const loads = [
      load({
        backlogWorkTicks: 0,
        contractId: "contract-light",
        measuredWorkTicks: 1,
        objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/00",
        reservationId: "reservation-light",
        sourceCapacityWorkTicks: 1,
        travelTicks: 0,
      }),
      load({
        backlogWorkTicks: 0,
        contractId: "contract-heavy",
        measuredWorkTicks: 1,
        minimumCapability: heavy,
        objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/01",
        reservationId: "reservation-heavy",
        sourceCapacityWorkTicks: 1,
        travelTicks: 0,
      }),
    ];
    const project = (actors: readonly WorkforceActor[]) =>
      new ColonyPopulationPolicy().project(
        input({ actors, funded: { loads, status: "ready" }, maximumBodyEnergy: 550 }),
      );

    expect(project([heavyActor, lightActor]).demands).toEqual([]);
    expect(project([lightActor, heavyActor])).toEqual(project([heavyActor, lightActor]));
  });
  it("replaces an expiring orthogonal carrier without inventing a heavy-slot deficit", () => {
    const carrier = { ...WCM, carry: 3, move: 2 };
    const heavy = { ...WCM, carry: 2, move: 3, work: 3 };
    const loads = [
      load({
        backlogWorkTicks: 0,
        contractId: "contract-carrier",
        measuredWorkTicks: 1,
        minimumCapability: carrier,
        objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/00",
        reservationId: "reservation-carrier",
        sourceCapacityWorkTicks: 1,
        travelTicks: 0,
      }),
      load({
        backlogWorkTicks: 0,
        contractId: "contract-heavy",
        measuredWorkTicks: 1,
        minimumCapability: heavy,
        objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/01",
        reservationId: "reservation-heavy",
        sourceCapacityWorkTicks: 1,
        travelTicks: 0,
      }),
    ];
    const projection = new ColonyPopulationPolicy().project(
      input({
        actors: [
          { ...actor(77), capability: carrier, id: "carrier", name: "carrier" },
          { ...actor(500), capability: heavy, id: "heavy", name: "heavy" },
        ],
        funded: { loads, status: "ready" },
        maximumBodyEnergy: 550,
      }),
    );

    expect(projection.demands).toEqual([
      expect.objectContaining({
        objectiveId: "growth/W1N1/upgrade-controller/controller-a/slot/00",
        requiredCapability: carrier,
      }),
    ]);
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
