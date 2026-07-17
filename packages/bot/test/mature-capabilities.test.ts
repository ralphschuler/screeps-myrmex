import { describe, expect, it } from "vitest";
import {
  deriveMatureCapabilities,
  normalizeMatureMechanics,
  type MatureMechanicsCatalog,
} from "../src/industry/mature-capabilities";
import type { StoreSnapshot } from "../src/world/snapshot";

const limits = {
  maximumCommodities: 8,
  maximumComponentsPerCommodity: 4,
  maximumResourceTypes: 16,
  maximumStringLength: 32,
};
const constants = {
  factoryCapacity: 50_000,
  nukerCooldown: 100_000,
  nukerEnergyCapacity: 300_000,
  nukerGhodiumCapacity: 5_000,
  nukerRange: 10,
  observerRange: 10,
  operateFactoryPower: 19,
  operateObserverPower: 7,
  operatePowerEffects: [1, 2, 3, 4, 5],
  operatePowerPower: 16,
  powerSpawnEnergyCapacity: 5_000,
  powerSpawnEnergyPerPower: 50,
  powerSpawnPowerCapacity: 100,
};
const commodities = {
  wire: { amount: 20, cooldown: 8, components: { energy: 40, silicon: 100 } },
  switch: { amount: 5, cooldown: 70, components: { energy: 20, wire: 40 }, level: 2 },
};
const resources = ["switch", "wire", "silicon", "energy", "power", "G"];

describe("mature structure capabilities", () => {
  it("normalizes reordered source mechanics into a byte-equivalent immutable catalog", () => {
    const forward = normalizeMatureMechanics({
      commodities,
      constants,
      limits,
      resourceTypes: resources,
    });
    const reversed = normalizeMatureMechanics({
      commodities: {
        switch: { level: 2, components: { wire: 40, energy: 20 }, cooldown: 70, amount: 5 },
        wire: { components: { silicon: 100, energy: 40 }, cooldown: 8, amount: 20 },
      },
      constants: Object.fromEntries(Object.entries(constants).reverse()),
      limits,
      resourceTypes: [...resources].reverse(),
    });

    expect(reversed).toEqual(forward);
    expect(forward.status).toBe("ready");
    if (forward.status === "ready") {
      expect(Object.isFrozen(forward.catalog.recipes[0]?.components)).toBe(true);
      expect(forward.catalog.recipes.map(({ product }) => product)).toEqual(["switch", "wire"]);
    }
  });

  it.each([
    [
      "unknown resource",
      { ...commodities, wire: { ...commodities.wire, components: { mist: 1 } } },
    ],
    ["unsupported level", { ...commodities, switch: { ...commodities.switch, level: 6 } }],
    ["non-positive amount", { ...commodities, wire: { ...commodities.wire, amount: 0 } }],
  ])("fails closed on %s mechanics", (_name, malformed) => {
    expect(
      normalizeMatureMechanics({
        commodities: malformed,
        constants,
        limits,
        resourceTypes: resources,
      }),
    ).toEqual({ catalog: null, reason: "invalid-input", status: "deferred" });
  });

  it("fails closed on cyclic object references and explicit bounds", () => {
    const cyclic: Record<string, unknown> = { amount: 1, cooldown: 1 };
    cyclic.components = cyclic;
    expect(
      normalizeMatureMechanics({
        commodities: { wire: cyclic },
        constants,
        limits,
        resourceTypes: resources,
      }),
    ).toMatchObject({ reason: "invalid-input", status: "deferred" });
    expect(
      normalizeMatureMechanics({
        commodities,
        constants,
        limits: { ...limits, maximumCommodities: 1 },
        resourceTypes: resources,
      }),
    ).toMatchObject({ reason: "limit-exceeded", status: "deferred" });
  });

  it("derives reset-stable capabilities from current facts without authorizing commands", () => {
    const catalog = readyCatalog();
    const input = {
      catalog,
      factories: [
        {
          active: true,
          cooldown: 0,
          effects: [{ effect: 19, level: 2, ticksRemaining: 10 }],
          hits: 1_000,
          hitsMax: 1_000,
          id: "factory-a",
          level: 2,
          pos: { roomName: "W1N1", x: 20, y: 20 },
          store: store({ energy: 100, silicon: 100, wire: 40 }),
        },
      ],
      limits: { maximumEffectsPerStructure: 8, maximumStructures: 4 },
      nukers: [
        {
          active: true,
          cooldown: 0,
          effects: [],
          hits: 1_000,
          hitsMax: 1_000,
          id: "nuker-a",
          pos: { roomName: "W1N1", x: 21, y: 20 },
          store: store({ energy: 300_000, G: 5_000 }),
        },
      ],
      observers: [
        {
          active: true,
          effects: [],
          hits: 500,
          hitsMax: 500,
          id: "observer-a",
          pos: { roomName: "W1N1", x: 22, y: 20 },
        },
      ],
      powerSpawns: [
        {
          active: true,
          effects: [],
          hits: 5_000,
          hitsMax: 5_000,
          id: "power-a",
          pos: { roomName: "W1N1", x: 23, y: 20 },
          store: store({ energy: 5_000, power: 100 }),
        },
      ],
      roomName: "W1N1",
    } as const;
    const beforeReset = deriveMatureCapabilities(input);
    const afterReset = deriveMatureCapabilities(JSON.parse(JSON.stringify(input)) as typeof input);

    expect(afterReset).toEqual(beforeReset);
    expect(beforeReset.status).toBe("ready");
    if (beforeReset.status === "ready") {
      expect(
        beforeReset.capabilities.find(({ kind }) => kind === "factory")?.availableProducts,
      ).toEqual(["switch", "wire"]);
      expect(
        beforeReset.capabilities.find(({ kind }) => kind === "power-spawn")?.processablePower,
      ).toBe(100);
      expect(beforeReset.capabilities.find(({ kind }) => kind === "observer")?.range).toBe(10);
      expect(beforeReset.capabilities.find(({ kind }) => kind === "nuker")?.stocked).toBe(true);
      expect(JSON.stringify(beforeReset)).not.toContain("produce");
      expect(JSON.stringify(beforeReset)).not.toContain("launchNuke");
    }
  });
});

function readyCatalog(): MatureMechanicsCatalog {
  const result = normalizeMatureMechanics({
    commodities,
    constants,
    limits,
    resourceTypes: resources,
  });
  if (result.status !== "ready") throw new Error("fixture mechanics must normalize");
  return result.catalog;
}

function store(resources: Readonly<Record<string, number>>): StoreSnapshot {
  const entries = Object.entries(resources)
    .map(([resourceType, amount]) => ({ amount, resourceType }))
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const usedCapacity = entries.reduce((total, { amount }) => total + amount, 0);
  return {
    capacity: 1_000_000,
    freeCapacity: 1_000_000 - usedCapacity,
    resources: entries,
    usedCapacity,
  };
}
