import { describe, expect, it, vi } from "vitest";
import { executeMatureIntents, type MatureExecutionAdapter } from "../src/industry/mature-executor";
import { projectMatureCommandTelemetry } from "../src/industry/mature-telemetry";
import type {
  MatureFactoryProduceIntent,
  MaturePowerProcessIntent,
} from "../src/industry/mature-runtime";
import type { ArbitrationBatch } from "../src/execution";

describe("mature structure executor", () => {
  it("issues accepted factory and power commands once with normalized results", () => {
    const factory = liveFactory();
    const powerSpawn = livePowerSpawn();
    const produce = vi.fn((): ScreepsReturnCode => -11);
    const processPower = vi.fn((): ScreepsReturnCode => 0);
    factory.produce = produce;
    powerSpawn.processPower = processPower;

    const results = executeMatureIntents(
      batch([factoryIntent(), powerIntent()]),
      100,
      adapter(factory, powerSpawn),
    );

    expect(produce).toHaveBeenCalledOnce();
    expect(produce).toHaveBeenCalledWith("wire");
    expect(processPower).toHaveBeenCalledOnce();
    expect(results).toEqual([
      expect.objectContaining({ reason: "ERR_TIRED", status: "rejected" }),
      expect.objectContaining({ reason: "OK", status: "executed" }),
    ]);
    expect(
      projectMatureCommandTelemetry({
        execution: results,
        intents: [factoryIntent(), powerIntent()],
        settlements: [
          {
            accounting: { energyInput: 40, resourceInput: 100, resourceOutput: 20 },
            attemptId: "factory-attempt",
            kind: "factory",
            objectiveId: "factory-objective",
            objectiveRevision: 1,
            reason: "exact-effect",
            retry: 0,
            settledAmount: 20,
            status: "settled",
          },
          {
            accounting: { energyInput: 0, resourceInput: 0, resourceOutput: 0 },
            attemptId: "power-attempt",
            kind: "power-processing",
            objectiveId: "power-objective",
            objectiveRevision: 1,
            reason: "no-effect",
            retry: 1,
            settledAmount: 0,
            status: "retry",
          },
        ],
      }),
    ).toEqual({
      accounting: {
        factory: [40, 100, 20],
        powerProcessing: [0, 0, 0],
      },
      commands: { executed: 1, failed: 0, rejected: 1 },
      intents: { factory: 1, powerProcessing: 1, total: 2 },
      settlements: { cancelled: 0, pending: 0, retries: 1 },
      truncated: false,
    });
  });

  it("fails closed before the factory API call when an observed store drifts", () => {
    const factory = liveFactory({ energy: 40, silicon: 99 });
    const powerSpawn = livePowerSpawn();
    const produce = vi.fn((): ScreepsReturnCode => 0);
    const processPower = vi.fn((): ScreepsReturnCode => 0);
    factory.produce = produce;
    powerSpawn.processPower = processPower;

    const results = executeMatureIntents(
      batch([factoryIntent(), powerIntent()]),
      100,
      adapter(factory, powerSpawn),
    );

    expect(produce).not.toHaveBeenCalled();
    expect(processPower).toHaveBeenCalledOnce();
    expect(results.map(({ reason }) => reason)).toEqual(["ERR_INVALID_TARGET", "OK"]);
  });

  it("fails every mature command closed when source mechanics drift", () => {
    const factory = liveFactory();
    const powerSpawn = livePowerSpawn();
    const produce = vi.fn((): ScreepsReturnCode => 0);
    const processPower = vi.fn((): ScreepsReturnCode => 0);
    factory.produce = produce;
    powerSpawn.processPower = processPower;

    const results = executeMatureIntents(batch([factoryIntent(), powerIntent()]), 100, {
      ...adapter(factory, powerSpawn),
      currentMechanicsFingerprint: () => "changed-mechanics",
    });

    expect(produce).not.toHaveBeenCalled();
    expect(processPower).not.toHaveBeenCalled();
    expect(results.every(({ reason }) => reason === "ERR_INVALID_TARGET")).toBe(true);
  });

  it.each([-1, -4, -6, -7, -8, -10, -11, -14] as const)(
    "normalizes documented factory return code %s",
    (code) => {
      const factory = liveFactory();
      factory.produce = vi.fn((): ScreepsReturnCode => code);
      expect(
        executeMatureIntents(batch([factoryIntent()]), 100, adapter(factory, livePowerSpawn()))[0]
          ?.returnCode,
      ).toBe(code);
    },
  );

  it.each([-1, -6, -14] as const)("normalizes documented power-spawn return code %s", (code) => {
    const powerSpawn = livePowerSpawn();
    powerSpawn.processPower = vi.fn((): ScreepsReturnCode => code);
    expect(
      executeMatureIntents(batch([powerIntent()]), 100, adapter(liveFactory(), powerSpawn))[0]
        ?.returnCode,
    ).toBe(code);
  });

  it("never executes rejected or unrelated intents", () => {
    const factory = liveFactory();
    const produce = vi.fn((): ScreepsReturnCode => 0);
    factory.produce = produce;
    expect(
      executeMatureIntents(
        { ...batch([factoryIntent()]), accepted: [] },
        100,
        adapter(factory, livePowerSpawn()),
      ),
    ).toEqual([]);
    expect(produce).not.toHaveBeenCalled();
  });
});

function factoryIntent(): MatureFactoryProduceIntent {
  return {
    ...base("factory.produce", "factory"),
    payload: {
      batchAmount: 20,
      capabilityFingerprint: "factory-capability",
      commitmentFingerprint: "factory-commitment",
      components: [
        { amount: 40, resourceType: "energy" },
        { amount: 100, resourceType: "silicon" },
      ],
      cooldown: 8,
      factoryLevel: null,
      mechanicsFingerprint: "mechanics",
      objectiveId: "factory-objective",
      objectiveRevision: 1,
      operateFactoryPower: 19,
      product: "wire",
      productBefore: 0,
      resourcesBefore: [
        { amount: 40, resourceType: "energy" },
        { amount: 100, resourceType: "silicon" },
        { amount: 0, resourceType: "wire" },
      ],
      roomName: "W1N1",
      storeCapacity: 50_000,
      storeUsedBefore: 140,
      structureId: "factory",
    },
  };
}

function powerIntent(): MaturePowerProcessIntent {
  return {
    ...base("power-spawn.process-power", "power-spawn"),
    priority: { class: "speculation", value: 10 },
    payload: {
      capabilityFingerprint: "power-capability",
      commitmentFingerprint: "power-commitment",
      energyBefore: 500,
      energyPerPower: 50,
      mechanicsFingerprint: "mechanics",
      objectiveId: "power-objective",
      objectiveRevision: 1,
      operatePowerEffect: 2,
      operatePowerLevel: 2,
      operatePowerPower: 16,
      powerBefore: 10,
      roomName: "W1N1",
      structureId: "power-spawn",
      units: 3,
    },
  };
}

function base<Kind extends string>(kind: Kind, target: string) {
  return {
    id: `intent/${kind}`,
    kind,
    issuer: "industry/W1N1/mature",
    tick: 100,
    target,
    snapshotRevision: "snapshot/100",
    exclusiveResourceKey: `mature-structure/${target}`,
    priority: { class: "speculation" as const, value: 20 },
    deadline: 100,
    budget: { id: "industry/mature", cost: 1 },
    preconditions: [],
  };
}

function batch(
  accepted: readonly (MatureFactoryProduceIntent | MaturePowerProcessIntent)[],
): ArbitrationBatch {
  return {
    tick: 100,
    submitted: accepted.length,
    acceptedBudget: accepted.length,
    accepted,
    decisions: [],
  };
}

function adapter(
  factory: StructureFactory,
  powerSpawn: StructurePowerSpawn,
): MatureExecutionAdapter {
  return {
    currentCapabilityFingerprint: (kind) =>
      kind === "factory" ? "factory-capability" : "power-capability",
    currentMechanicsFingerprint: () => "mechanics",
    resolveFactory: (id) => (id === factory.id ? factory : null),
    resolvePowerSpawn: (id) => (id === powerSpawn.id ? powerSpawn : null),
  };
}

function liveFactory(resources: Readonly<Record<string, number>> = { energy: 40, silicon: 100 }) {
  return {
    id: "factory",
    my: true,
    cooldown: 0,
    level: undefined,
    effects: [],
    room: { controller: { my: true, level: 8 } },
    isActive: () => true,
    store: liveStore(resources, 50_000),
    produce: vi.fn(() => 0),
  } as unknown as StructureFactory;
}

function livePowerSpawn() {
  return {
    id: "power-spawn",
    my: true,
    effects: [{ effect: 16, level: 2, ticksRemaining: 50 }],
    room: { controller: { my: true, level: 8 } },
    isActive: () => true,
    store: liveStore({ energy: 500, power: 10 }, 5_100),
    processPower: vi.fn(() => 0),
  } as unknown as StructurePowerSpawn;
}

function liveStore(resources: Readonly<Record<string, number>>, capacity: number) {
  const used = Object.values(resources).reduce((total, amount) => total + amount, 0);
  return {
    getCapacity: () => capacity,
    getFreeCapacity: () => capacity - used,
    getUsedCapacity: (resource?: string) =>
      resource === undefined ? used : (resources[resource] ?? 0),
  };
}
