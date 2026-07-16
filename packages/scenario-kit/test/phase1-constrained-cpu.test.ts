import { describe, expect, it } from "vitest";
import {
  CpuScheduler,
  CpuTickBudget,
  deriveCpuMode,
  RuntimeKernel,
  type CpuPolicy,
  type CpuSource,
  type StagedSystemResult,
  type SystemDescriptor,
  type SystemRunScope,
  type TickSystem,
} from "../../bot/src/runtime/kernel";
import { defineReplayScenario, runScenario, type ReplayScenario } from "../src";

const CPU_BUDGET = 8;
const CPU_USED = 5;
const MANDATORY_TAIL_RESERVE = 3;
const FIRST_TICK = 31_000;

const CPU_POLICY: Partial<CpuPolicy> = {
  emergencyBucketBelow: 10,
  constrainedBucketBelow: 50,
  surplusBucketAt: 90,
  mandatoryTailReserve: MANDATORY_TAIL_RESERVE,
};

interface CpuMeter extends CpuSource {
  readonly used: number;
  consume(amount: number): void;
}

class ScenarioCpu implements CpuMeter {
  public used = 0;

  public constructor(
    public readonly bucket = 30,
    public readonly limit = CPU_BUDGET,
    public readonly tickLimit = CPU_BUDGET,
  ) {}

  public consume(amount: number): void {
    this.used += amount;
  }

  public getUsed(): number {
    return this.used;
  }
}

interface CpuContext {
  readonly cpu: ScenarioCpu;
  readonly events: string[];
}

interface CpuWorld {
  readonly ticks: number;
}

interface CpuInput {
  readonly reverseSystems: boolean;
}

interface CpuOutcome {
  readonly mode: string;
  readonly cpuUsed: number;
  readonly systems: readonly {
    readonly id: string;
    readonly status: string;
    readonly skipReason: string | null;
  }[];
  readonly events: readonly string[];
}

interface CpuHeap {
  readonly kernel: RuntimeKernel<CpuContext>;
}

describe("Phase 1 constrained CPU replay (#30)", () => {
  it("preserves mandatory safety, spawn, execution, reconciliation, and telemetry", () => {
    const warm = runScenario(constrainedCpuScenario(false, false));
    const reset = runScenario(constrainedCpuScenario(true, false));
    const reordered = runScenario(constrainedCpuScenario(true, true));

    expect(reset.outcomes).toEqual(warm.outcomes);
    expect(reset.finalWorld).toEqual(warm.finalWorld);
    expect(reset.outcomeHash).toBe(warm.outcomeHash);
    expect(reordered.outcomes).toEqual(warm.outcomes);
    expect(reordered.finalWorld).toEqual(warm.finalWorld);
    expect(reordered.outcomeHash).toBe(warm.outcomeHash);
    expect(reset.transcriptHash).not.toBe(warm.transcriptHash);
    expect(reset.transcript.ticks.map(({ heapReset }) => heapReset)).toEqual([
      false,
      false,
      true,
      false,
    ]);

    for (const outcome of warm.outcomes) {
      expect(outcome.mode).toBe("constrained");
      expect(outcome.cpuUsed).toBe(CPU_USED);
      expect(outcome.events).toEqual([
        "safety",
        "spawn",
        "execute",
        "reconcile",
        "telemetry.minimum",
      ]);
      expect(outcome.systems).toEqual([
        { id: "safety", status: "completed", skipReason: null },
        { id: "spawn", status: "completed", skipReason: null },
        { id: "growth", status: "skipped", skipReason: "cpu-mode" },
        { id: "execute", status: "completed", skipReason: null },
        { id: "reconcile", status: "completed", skipReason: null },
        { id: "telemetry.minimum", status: "completed", skipReason: null },
      ]);
    }
  });
});

function constrainedCpuScenario(
  resetHeap: boolean,
  reverseSystems: boolean,
): ReplayScenario<CpuWorld, CpuInput, CpuOutcome, CpuHeap> {
  const input = { reverseSystems };
  return defineReplayScenario({
    id: "phase1/constrained-cpu-mandatory-tail",
    seed: "phase1-constrained-cpu",
    initialWorld: { ticks: 0 },
    ticks: [0, 1, 2, 3].map((offset) => ({
      gameTime: FIRST_TICK + offset,
      input,
      cpuBudget: CPU_BUDGET,
      resetHeap: resetHeap && offset === 2,
    })),
    createHeap: ({ input: heapInput }) => ({
      kernel: new RuntimeKernel(makeSystems(heapInput.reverseSystems), { cpuPolicy: CPU_POLICY }),
    }),
    resetHeap: ({ input: heapInput }) => ({
      kernel: new RuntimeKernel(makeSystems(heapInput.reverseSystems), { cpuPolicy: CPU_POLICY }),
    }),
    assertCpu: ({ budget, used, remaining }) => {
      expect(budget).toBe(CPU_BUDGET);
      expect(used).toBe(CPU_USED);
      expect(remaining).toBe(MANDATORY_TAIL_RESERVE);
    },
    step: ({ gameTime, world, heap }) => {
      const cpu = new ScenarioCpu();
      const events: string[] = [];
      const report = heap.kernel.run({
        tick: gameTime,
        context: { cpu, events },
        cpu,
        signals: { recentUsageRatio: 0 },
      });

      const scheduler = new CpuScheduler(CPU_POLICY);
      const admissionBudget = scheduler.startTick(cpu);
      expect(admissionBudget).toBeInstanceOf(CpuTickBudget);
      expect(deriveCpuMode(admissionBudget.snapshot, {}, scheduler.policy)).toBe("constrained");
      expect(admissionBudget.admit(descriptor("growth", "plan", "economic"), 0).reason).toBe(
        "cpu-mode",
      );

      return {
        nextWorld: { ticks: world.ticks + 1 },
        outcome: {
          mode: report.mode,
          cpuUsed: report.cpuUsed,
          systems: report.systems.map(({ systemId, status, skipReason }) => ({
            id: systemId,
            status,
            skipReason,
          })),
          events,
        },
        cpuUsed: CPU_USED,
      };
    },
  });
}

function makeSystems(reverse: boolean): readonly TickSystem<CpuContext>[] {
  const systems = [
    makeSystem("safety", "safety", "mandatory"),
    makeSystem("spawn", "plan", "mandatory"),
    makeSystem("growth", "plan", "economic"),
    makeSystem("execute", "execute", "mandatory", true),
    makeSystem("reconcile", "reconcile", "mandatory", true),
    makeSystem("telemetry.minimum", "telemetry", "mandatory", true),
  ];
  return reverse ? systems.reverse() : systems;
}

function descriptor(
  id: string,
  phase: SystemDescriptor["phase"],
  criticality: SystemDescriptor["criticality"],
  mandatoryTail = false,
): SystemDescriptor {
  return {
    id,
    phase,
    criticality,
    cadence: 1,
    estimate: 1,
    admitInRecovery: false,
    mandatoryTail,
  };
}

function makeSystem(
  id: string,
  phase: SystemDescriptor["phase"],
  criticality: SystemDescriptor["criticality"],
  mandatoryTail = false,
): TickSystem<CpuContext> {
  return {
    descriptor: descriptor(id, phase, criticality, mandatoryTail),
    run: ({ context }: SystemRunScope<CpuContext>): StagedSystemResult => ({
      commit: () => {
        context.cpu.consume(1);
        context.events.push(id);
      },
    }),
  };
}
