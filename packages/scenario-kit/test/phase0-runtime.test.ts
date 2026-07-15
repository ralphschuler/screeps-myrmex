/// <reference types="screeps" />

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  RuntimeKernel,
  type CpuSource,
  type StagedSystemResult,
  type SystemDescriptor,
  type SystemRunScope,
  type TickSystem,
} from "../../bot/src/runtime/kernel";
import { createIntentChannel, executeAcceptedIntentBatch } from "../../bot/src/execution";
import { openMyrmexMemory } from "../../bot/src/state/memory";
import type { RuntimeGame } from "../../bot/src/runtime/context";
import { observeWorld } from "../../bot/src/world/observe";
import type { WorldSnapshot } from "../../bot/src/world/snapshot";
import {
  canonicalHash,
  defineReplayScenario,
  runScenario,
  type ReplayScenario,
} from "../src/index";

const FIND_CREEPS_VALUE = 101;
const FIND_SOURCES_VALUE = 105;
const FIND_STRUCTURES_VALUE = 107;
const FIND_CONSTRUCTION_SITES_VALUE = 111;

interface DurableWorld {
  readonly memory: Record<string, unknown>;
}

interface BootOutcome {
  readonly bootCount: number;
  readonly revision: number;
  readonly status: "ready";
}

interface KernelContext {
  readonly cpu: ScenarioCpu;
  readonly events: string[];
}

interface MigrationOutcome {
  readonly events: readonly string[];
  readonly mode: string;
  readonly nextStep: number | null;
  readonly status: "ready" | "recovery";
  readonly systems: readonly SystemOutcome[];
}

interface SystemOutcome {
  readonly id: string;
  readonly skipReason: string | null;
  readonly status: string;
}

interface FaultWorld {
  readonly successfulExecutions: number;
}

interface FaultOutcome {
  readonly events: readonly string[];
  readonly faultStage: string | null;
  readonly inputRevision: string | null;
  readonly laterStatus: string;
}

interface CpuPressureInput {
  readonly bucket: number;
}

interface CpuPressureWorld {
  readonly tailRuns: number;
}

interface CpuPressureOutcome {
  readonly cpuUsed: number;
  readonly events: readonly string[];
  readonly mode: string;
  readonly ordinarySkipReason: string | null;
  readonly tailStatuses: readonly string[];
}

interface ObservationWorld {
  readonly snapshot: WorldSnapshot | null;
}

interface ObservationOutcome {
  readonly roomNames: readonly string[];
  readonly snapshotHash: string;
  readonly sourceIds: readonly string[];
}

interface CommandWorld {
  readonly issued: number;
}

interface CommandInput {
  readonly reverse: boolean;
}

interface CommandOutcome {
  readonly decisions: readonly {
    readonly id: string;
    readonly reason: string | null;
    readonly status: string;
  }[];
  readonly result: {
    readonly intentId: string;
    readonly reason: string;
    readonly status: string;
  };
}

class ScenarioCpu implements CpuSource {
  public used = 0;

  public constructor(
    public readonly bucket: number,
    public readonly limit: number,
    public readonly tickLimit: number,
  ) {}

  public consume(amount: number): void {
    this.used += amount;
  }

  public getUsed(): number {
    return this.used;
  }
}

class LivePosition {
  public constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly roomName: string,
  ) {}
}

describe("Phase 0 deterministic runtime scenarios", () => {
  beforeAll(() => {
    vi.stubGlobal("FIND_CREEPS", FIND_CREEPS_VALUE);
    vi.stubGlobal("FIND_SOURCES", FIND_SOURCES_VALUE);
    vi.stubGlobal("FIND_STRUCTURES", FIND_STRUCTURES_VALUE);
    vi.stubGlobal("FIND_CONSTRUCTION_SITES", FIND_CONSTRUCTION_SITES_VALUE);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("cold-boots durable state and remains outcome-equivalent across a heap reset", () => {
    const uninterrupted = runScenario(coldBootScenario(false));
    const reset = runScenario(coldBootScenario(true));

    expect(reset.outcomes).toEqual(uninterrupted.outcomes);
    expect(reset.finalWorld).toEqual(uninterrupted.finalWorld);
    expect(reset.outcomeHash).toBe(uninterrupted.outcomeHash);
    expect(reset.transcriptHash).not.toBe(uninterrupted.transcriptHash);
    expect(reset.transcript.ticks.map((tick) => tick.heapReset)).toEqual([false, true, false]);
    expect(reset.outcomes).toEqual([
      { bootCount: 1, revision: 1, status: "ready" },
      { bootCount: 2, revision: 2, status: "ready" },
      { bootCount: 3, revision: 3, status: "ready" },
    ]);

    const root = reset.finalWorld.memory.myrmex as {
      readonly kernel: { readonly bootCount: number };
      readonly meta: {
        readonly firstTick: number;
        readonly lastTick: number;
        readonly migration: null;
        readonly recovery: null;
        readonly revision: number;
        readonly schemaVersion: number;
      };
    };
    expect(root.meta).toMatchObject({
      schemaVersion: 3,
      revision: 3,
      firstTick: 100,
      lastTick: 102,
      migration: null,
      recovery: null,
    });
    expect(root.kernel.bootCount).toBe(3);
    expect(root).not.toHaveProperty("world");
  });

  it("replays bounded v1 migration in recovery mode and resumes identically after reset", () => {
    const uninterrupted = runScenario(migrationScenario(false));
    const reset = runScenario(migrationScenario(true));

    expect(reset.outcomes).toEqual(uninterrupted.outcomes);
    expect(reset.finalWorld).toEqual(uninterrupted.finalWorld);
    expect(reset.outcomeHash).toBe(uninterrupted.outcomeHash);
    expect(
      reset.outcomes.map((outcome) => [outcome.status, outcome.nextStep, outcome.mode]),
    ).toEqual([
      ["recovery", 0, "recovery"],
      ["recovery", 1, "recovery"],
      ["recovery", 2, "recovery"],
      ["recovery", 3, "recovery"],
      ["recovery", 0, "recovery"],
      ["ready", null, "normal"],
    ]);

    for (const outcome of reset.outcomes.slice(0, -1)) {
      expect(outcome.events).toEqual(["recovery-safe", "tail"]);
      expect(outcome.systems).toEqual(
        expect.arrayContaining([
          { id: "recovery-safe", skipReason: null, status: "completed" },
          { id: "planner", skipReason: "cpu-mode", status: "skipped" },
          { id: "reconcile-tail", skipReason: null, status: "completed" },
        ]),
      );
    }

    expect(reset.outcomes[reset.outcomes.length - 1]?.events).toEqual([
      "recovery-safe",
      "planner",
      "tail",
    ]);
    const root = reset.finalWorld.memory.myrmex as Record<string, unknown>;
    expect(root).not.toHaveProperty("world");
    expect(root).toHaveProperty("telemetry", {});
  });

  it("isolates a staged commit fault and continues later execution deterministically", () => {
    const first = runScenario(faultIsolationScenario());
    const repeated = runScenario(faultIsolationScenario());

    expect(repeated).toEqual(first);
    expect(first.finalWorld.successfulExecutions).toBe(2);
    expect(first.outcomes).toEqual([
      {
        events: ["commit:failing", "discard:commit", "commit:later"],
        faultStage: "commit",
        inputRevision: canonicalHash({ successfulExecutions: 0 }),
        laterStatus: "completed",
      },
      {
        events: ["commit:failing", "discard:commit", "commit:later"],
        faultStage: "commit",
        inputRevision: canonicalHash({ successfulExecutions: 1 }),
        laterStatus: "completed",
      },
    ]);
  });

  it("preserves mandatory execute/reconcile/telemetry work under CPU pressure", () => {
    const result = runScenario(cpuPressureScenario());

    expect(result.outcomes).toEqual([
      {
        cpuUsed: 3,
        events: ["execute-tail", "reconcile-tail", "telemetry-tail"],
        mode: "normal",
        ordinarySkipReason: "tail-reserve",
        tailStatuses: ["completed", "completed", "completed"],
      },
      {
        cpuUsed: 3,
        events: ["execute-tail", "reconcile-tail", "telemetry-tail"],
        mode: "emergency",
        ordinarySkipReason: "cpu-mode",
        tailStatuses: ["completed", "completed", "completed"],
      },
    ]);
    expect(result.finalWorld.tailRuns).toBe(6);
  });

  it("produces byte-identical replay outcomes from reordered live world collections", () => {
    const forward = runScenario(observationOrderScenario(false));
    const reversed = runScenario(observationOrderScenario(true));

    expect(reversed).toEqual(forward);
    expect(forward.outcomes.map((outcome) => outcome.roomNames)).toEqual([
      ["W1N1", "W2N2"],
      ["W1N1", "W2N2"],
    ]);
    expect(forward.outcomes.map((outcome) => outcome.sourceIds)).toEqual([
      ["source-a", "source-b"],
      ["source-a", "source-b"],
    ]);
    const visibility = forward.finalWorld.snapshot?.visibility.rooms ?? [];
    expect(visibility[visibility.length - 1]).toEqual({
      age: null,
      observedAt: null,
      roomName: "W9N9",
      status: "unknown",
    });
  });

  it("replays reordered intent conflicts and legal command errors identically", () => {
    const forward = runScenario(commandResultScenario(false));
    const reversed = runScenario(commandResultScenario(true));

    expect(reversed.outcomes).toEqual(forward.outcomes);
    expect(reversed.finalWorld).toEqual(forward.finalWorld);
    expect(reversed.outcomeHash).toBe(forward.outcomeHash);
    expect(forward.finalWorld.issued).toBe(2);
    expect(forward.outcomes.map(({ result }) => result)).toEqual([
      { intentId: "move:a", reason: "ERR_NOT_IN_RANGE", status: "rejected" },
      { intentId: "move:a", reason: "OK", status: "executed" },
    ]);
  });
});

function commandResultScenario(
  reverse: boolean,
): ReplayScenario<CommandWorld, CommandInput, CommandOutcome> {
  return defineReplayScenario<CommandWorld, CommandInput, CommandOutcome>({
    id: "phase0/execution/reordered-command-result",
    seed: "phase0-command-result",
    initialWorld: { issued: 0 },
    ticks: [700, 701].map((gameTime) => ({
      gameTime,
      input: { reverse },
      cpuBudget: 2,
    })),
    step: ({ gameTime, input, world }) => {
      const channel = createIntentChannel({
        maximumSubmitted: 2,
        maximumAccepted: 1,
        maximumBudget: 1,
        overloadPolicy: "reject",
      });
      const ids = input.reverse ? (["move:b", "move:a"] as const) : (["move:a", "move:b"] as const);
      const producerScope = channel.openProducer("scenario.execution-planner");
      for (const id of ids) {
        producerScope.producer.submit({
          id,
          kind: "move",
          issuer: "scenario",
          tick: gameTime,
          target: "creep:1",
          snapshotRevision: `world:${String(gameTime)}`,
          exclusiveResourceKey: "actor:creep:1",
          priority: { class: "survival", value: 1 },
          deadline: gameTime,
          budget: { id: "movement", cost: 1 },
          preconditions: [],
          payload: { actorId: "creep:1", direction: 1 },
        });
      }
      producerScope.stage().commit();
      const arbitration = channel.arbiter.arbitrate({
        tick: gameTime,
        snapshotRevision: `world:${String(gameTime)}`,
      });
      const results = executeAcceptedIntentBatch({
        tick: gameTime,
        arbitration,
        commandFor: (intent) => intent.payload,
        adapter: { issue: () => (gameTime === 700 ? -9 : 0) },
      });
      const result = results[0];
      if (result === undefined) {
        throw new Error("accepted movement intent produced no command result");
      }

      return {
        nextWorld: { issued: world.issued + results.length },
        outcome: {
          decisions: arbitration.decisions.map((decision) => ({
            id: decision.intent.id,
            reason: decision.reason,
            status: decision.status,
          })),
          result: {
            intentId: result.intentId,
            reason: result.reason,
            status: result.status,
          },
        },
        cpuUsed: 1,
      };
    },
  });
}

function coldBootScenario(resetHeap: boolean): ReplayScenario<DurableWorld, null, BootOutcome> {
  return defineReplayScenario<DurableWorld, null, BootOutcome>({
    id: "phase0/state/cold-boot-reset-equivalence",
    seed: "phase0-cold-boot",
    initialWorld: { memory: {} },
    ticks: [100, 101, 102].map((gameTime, index) => ({
      gameTime,
      input: null,
      cpuBudget: 2,
      resetHeap: resetHeap && index === 1,
    })),
    step: ({ gameTime, world }) => {
      const memory = cloneMemory(world.memory);
      const opened = openMyrmexMemory(memory, gameTime, "shard3");
      if (opened.status !== "ready") {
        throw new Error(`cold boot unexpectedly entered ${opened.status}`);
      }

      const transaction = opened.manager.transaction("kernel");
      transaction.mutate((draft) => {
        const current = typeof draft.bootCount === "number" ? draft.bootCount : 0;
        draft.bootCount = current + 1;
      });
      const staged = transaction.stage();
      if (!staged.staged) {
        throw new Error("cold-boot kernel transaction did not stage");
      }
      const committed = opened.manager.commitReconciliation();
      if (!committed.committed) {
        throw new Error("cold-boot reconciliation did not commit");
      }

      return {
        nextWorld: { memory: serializeMemory(memory) },
        outcome: {
          bootCount: readNumber(opened.manager.ownerView("kernel"), "bootCount"),
          revision: committed.revision,
          status: "ready" as const,
        },
        cpuUsed: 1,
      };
    },
  });
}

function migrationScenario(
  resetHeap: boolean,
): ReplayScenario<DurableWorld, null, MigrationOutcome, { kernel: RuntimeKernel<KernelContext> }> {
  return defineReplayScenario<
    DurableWorld,
    null,
    MigrationOutcome,
    { kernel: RuntimeKernel<KernelContext> }
  >({
    id: "phase0/state/v1-bounded-recovery",
    seed: "phase0-v1-migration",
    initialWorld: {
      memory: {
        myrmex: {
          schema: 1,
          boot: { firstTick: 7, lastTick: 99, shard: "shard3" },
          world: { observedAt: 99, ownedRooms: [{ name: "W1N1" }] },
          telemetry: { cpuUsed: 12 },
        },
      },
    },
    ticks: [500, 501, 502, 503, 504, 505].map((gameTime, index) => ({
      gameTime,
      input: null,
      cpuBudget: 5,
      resetHeap: resetHeap && index === 2,
    })),
    createHeap: () => ({ kernel: makeRecoveryKernel() }),
    step: ({ gameTime, heap, world }) => {
      const memory = cloneMemory(world.memory);
      const opened = openMyrmexMemory(memory, gameTime, "shard3");
      if (opened.status === "unsupported") {
        throw new Error("legacy v1 state was treated as a future schema");
      }

      const cpu = new ScenarioCpu(6_000, 20, 20);
      const events: string[] = [];
      const report = heap.kernel.run({
        tick: gameTime,
        context: { cpu, events },
        cpu,
        signals: { recoveryRequired: opened.status === "recovery" },
        inputRevision: canonicalHash(world),
      });

      return {
        nextWorld: { memory: serializeMemory(memory) },
        outcome: {
          events,
          mode: report.mode,
          nextStep: opened.status === "recovery" ? opened.cursor.nextStep : null,
          status: opened.status,
          systems: summarizeSystems(report.systems),
        },
        cpuUsed: report.cpuUsed,
      };
    },
  });
}

function faultIsolationScenario(): ReplayScenario<
  FaultWorld,
  null,
  FaultOutcome,
  { kernel: RuntimeKernel<KernelContext> }
> {
  return defineReplayScenario<
    FaultWorld,
    null,
    FaultOutcome,
    { kernel: RuntimeKernel<KernelContext> }
  >({
    id: "phase0/kernel/fault-isolation",
    seed: "phase0-fault-isolation",
    initialWorld: { successfulExecutions: 0 },
    ticks: [700, 701].map((gameTime) => ({ gameTime, input: null, cpuBudget: 5 })),
    createHeap: () => ({ kernel: makeFaultIsolationKernel() }),
    step: ({ gameTime, heap, world }) => {
      const cpu = new ScenarioCpu(6_000, 20, 20);
      const events: string[] = [];
      const inputRevision = canonicalHash(world);
      const report = heap.kernel.run({
        tick: gameTime,
        context: { cpu, events },
        cpu,
        inputRevision,
      });
      const failing = report.systems.find((system) => system.systemId === "failing");
      const later = report.systems.find((system) => system.systemId === "later");
      if (failing === undefined || later === undefined) {
        throw new Error("fault-isolation systems were not reported");
      }

      return {
        nextWorld: { successfulExecutions: world.successfulExecutions + 1 },
        outcome: {
          events,
          faultStage: failing.fault?.stage ?? null,
          inputRevision: failing.fault?.inputRevision ?? null,
          laterStatus: later.status,
        },
        cpuUsed: report.cpuUsed,
      };
    },
  });
}

function cpuPressureScenario(): ReplayScenario<
  CpuPressureWorld,
  CpuPressureInput,
  CpuPressureOutcome,
  { kernel: RuntimeKernel<KernelContext> }
> {
  return defineReplayScenario<
    CpuPressureWorld,
    CpuPressureInput,
    CpuPressureOutcome,
    { kernel: RuntimeKernel<KernelContext> }
  >({
    id: "phase0/kernel/cpu-tail-pressure",
    seed: "phase0-cpu-pressure",
    initialWorld: { tailRuns: 0 },
    ticks: [
      { gameTime: 800, input: { bucket: 6_000 }, cpuBudget: 10 },
      { gameTime: 801, input: { bucket: 500 }, cpuBudget: 10 },
    ],
    createHeap: () => ({ kernel: makeCpuPressureKernel() }),
    step: ({ gameTime, heap, input, world }) => {
      const cpu = new ScenarioCpu(input.bucket, 10, 10);
      const events: string[] = [];
      const report = heap.kernel.run({ tick: gameTime, context: { cpu, events }, cpu });
      const ordinary = report.systems.find((system) => system.systemId === "ordinary");
      const tailReports = ["execute-tail", "reconcile-tail", "telemetry-tail"].map((id) =>
        report.systems.find((system) => system.systemId === id),
      );
      if (ordinary === undefined || tailReports.some((tail) => tail === undefined)) {
        throw new Error("CPU pressure systems were not reported");
      }

      return {
        nextWorld: { tailRuns: world.tailRuns + events.length },
        outcome: {
          cpuUsed: report.cpuUsed,
          events,
          mode: report.mode,
          ordinarySkipReason: ordinary.skipReason,
          tailStatuses: tailReports.map((tail) => tail?.status ?? "missing"),
        },
        cpuUsed: report.cpuUsed,
      };
    },
  });
}

function observationOrderScenario(
  reversed: boolean,
): ReplayScenario<ObservationWorld, null, ObservationOutcome> {
  return defineReplayScenario<ObservationWorld, null, ObservationOutcome>({
    id: "phase0/world/reordered-observation",
    seed: "phase0-world-order",
    initialWorld: { snapshot: null },
    ticks: [900, 901].map((gameTime) => ({ gameTime, input: null, cpuBudget: 5 })),
    step: ({ gameTime }) => {
      const snapshot = observeWorld(makeObservationGame(gameTime, reversed), {
        requestedRoomNames: reversed ? ["W9N9", "W1N1"] : ["W1N1", "W9N9"],
      });

      return {
        nextWorld: { snapshot },
        outcome: {
          roomNames: snapshot.rooms.map((room) => room.name),
          snapshotHash: canonicalHash(snapshot),
          sourceIds: snapshot.rooms[0]?.sources.map((source) => source.id) ?? [],
        },
        cpuUsed: 1,
      };
    },
  });
}

function makeRecoveryKernel(): RuntimeKernel<KernelContext> {
  return new RuntimeKernel([
    makeSystem(
      "recovery-safe",
      { phase: "boot", criticality: "operational", estimate: 0.25, admitInRecovery: true },
      consumeAndCommit("recovery-safe", 0.25),
    ),
    makeSystem(
      "planner",
      { phase: "plan", criticality: "economic", estimate: 0.5 },
      consumeAndCommit("planner", 0.5),
    ),
    makeSystem(
      "reconcile-tail",
      {
        phase: "reconcile",
        criticality: "mandatory",
        estimate: 0.25,
        admitInRecovery: true,
        mandatoryTail: true,
      },
      consumeAndCommit("tail", 0.25),
    ),
  ]);
}

function makeFaultIsolationKernel(): RuntimeKernel<KernelContext> {
  return new RuntimeKernel([
    makeSystem("failing", { estimate: 0.4 }, ({ context }) => {
      context.cpu.consume(0.4);
      return {
        commit: () => {
          context.events.push("commit:failing");
          throw new Error("commit rejected");
        },
        discard: (fault) => context.events.push(`discard:${fault.stage}`),
      };
    }),
    makeSystem(
      "later",
      { phase: "execute", criticality: "operational", estimate: 0.2 },
      consumeAndCommit("commit:later", 0.2),
    ),
  ]);
}

function makeCpuPressureKernel(): RuntimeKernel<KernelContext> {
  return new RuntimeKernel(
    [
      makeSystem("ordinary", { estimate: 8 }, consumeAndCommit("ordinary", 8)),
      ...(["execute", "reconcile", "telemetry"] as const).map((phase) =>
        makeSystem(
          `${phase}-tail`,
          {
            phase,
            criticality: "mandatory",
            estimate: 1,
            admitInRecovery: true,
            mandatoryTail: true,
          },
          consumeAndCommit(`${phase}-tail`, 1),
        ),
      ),
    ],
    { cpuPolicy: { mandatoryTailReserve: 3 } },
  );
}

function makeSystem(
  id: string,
  overrides: Partial<SystemDescriptor>,
  run: (scope: SystemRunScope<KernelContext>) => StagedSystemResult,
): TickSystem<KernelContext> {
  return {
    descriptor: {
      id,
      phase: "plan",
      criticality: "economic",
      cadence: 1,
      estimate: 1,
      admitInRecovery: false,
      mandatoryTail: false,
      ...overrides,
    },
    run,
  };
}

function consumeAndCommit(
  event: string,
  amount: number,
): (scope: SystemRunScope<KernelContext>) => StagedSystemResult {
  return ({ context }) => {
    context.cpu.consume(amount);
    return { commit: () => context.events.push(event) };
  };
}

function summarizeSystems(
  systems: readonly {
    readonly systemId: string;
    readonly skipReason: string | null;
    readonly status: string;
  }[],
): readonly SystemOutcome[] {
  return systems.map((system) => ({
    id: system.systemId,
    skipReason: system.skipReason,
    status: system.status,
  }));
}

function makeObservationGame(gameTime: number, reversed: boolean): RuntimeGame {
  const first = makeObservationRoom("W1N1", ["source-b", "source-a"], reversed);
  const second = makeObservationRoom("W2N2", ["source-z"], reversed);
  const rooms = reversed ? { W2N2: second, W1N1: first } : { W1N1: first, W2N2: second };

  const cpu = { bucket: 10_000, limit: 20, tickLimit: 100, getUsed: () => 0 };
  return {
    cpu,
    rooms,
    shard: { name: "shard3" },
    time: gameTime,
  };
}

function makeObservationRoom(name: string, sourceIds: readonly string[], reversed: boolean): Room {
  const sources = sourceIds.map((id, index) => ({
    energy: 3_000 - index * 100,
    energyCapacity: 3_000,
    id,
    pos: new LivePosition(10 + index, 20 + index, name),
    ticksToRegeneration: 15 + index,
  }));

  return {
    controller: undefined,
    energyAvailable: 0,
    energyCapacityAvailable: 0,
    find: (findType: number): unknown[] => {
      const values = findType === FIND_SOURCES_VALUE ? sources : [];
      return reversed ? [...values].reverse() : [...values];
    },
    name,
  } as unknown as Room;
}

function cloneMemory(value: Record<string, unknown>): Memory {
  return JSON.parse(JSON.stringify(value)) as Memory;
}

function serializeMemory(memory: Memory): Record<string, unknown> {
  return JSON.parse(JSON.stringify(memory)) as Record<string, unknown>;
}

function readNumber(value: Readonly<Record<string, unknown>>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== "number") {
    throw new Error(`${key} is not a number`);
  }
  return candidate;
}
