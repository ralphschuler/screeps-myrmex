import { describe, expect, it } from "vitest";
import {
  CpuScheduler,
  RuntimeKernel,
  type CpuPolicy,
  type CpuSource,
  type StagedSystemResult,
  type SystemDescriptor,
  type SystemHealthRecord,
  type SystemRunScope,
  type TickSystem,
} from "../src/runtime/kernel";

class TestCpu implements CpuSource {
  public used = 0;

  public constructor(
    public readonly bucket = 6_000,
    public readonly limit = 20,
    public readonly tickLimit = 100,
  ) {}

  public getUsed(): number {
    return this.used;
  }

  public consume(amount: number): void {
    this.used += amount;
  }
}

interface TestContext {
  readonly cpu: TestCpu;
  readonly events: string[];
}

function makeDescriptor(id: string, overrides: Partial<SystemDescriptor> = {}): SystemDescriptor {
  return {
    id,
    phase: "plan",
    criticality: "economic",
    cadence: 1,
    estimate: 1,
    admitInRecovery: false,
    mandatoryTail: false,
    ...overrides,
  };
}

function makeSystem(
  id: string,
  overrides: Partial<SystemDescriptor> = {},
  run: (scope: SystemRunScope<TestContext>) => StagedSystemResult = ({ context }) => ({
    commit: () => context.events.push(`commit:${id}`),
  }),
): TickSystem<TestContext> {
  return {
    descriptor: makeDescriptor(id, overrides),
    run,
  };
}

function runOnce(
  systems: readonly TickSystem<TestContext>[],
  cpu = new TestCpu(),
  tick = 1,
  options: {
    readonly cpuPolicy?: Partial<CpuPolicy>;
    readonly signals?: {
      readonly recoveryRequired?: boolean;
      readonly activeThreat?: boolean;
      readonly recentUsageRatio?: number;
    };
  } = {},
) {
  const events: string[] = [];
  const kernel = new RuntimeKernel(
    systems,
    options.cpuPolicy === undefined ? {} : { cpuPolicy: options.cpuPolicy },
  );
  const report = kernel.run({
    tick,
    context: { cpu, events },
    cpu,
    ...(options.signals === undefined ? {} : { signals: options.signals }),
  });
  return { events, kernel, report };
}

describe("RuntimeKernel", () => {
  it("uses phase, criticality, and stable id ordering instead of registration order", () => {
    const systems = [
      makeSystem("plan-z"),
      makeSystem("observe-z", { phase: "observe", criticality: "economic" }),
      makeSystem("plan-a"),
      makeSystem("observe-mandatory", {
        phase: "observe",
        criticality: "mandatory",
      }),
      makeSystem("boot", { phase: "boot", criticality: "mandatory" }),
    ];

    const { events, report } = runOnce(systems);

    expect(events).toEqual([
      "commit:boot",
      "commit:observe-mandatory",
      "commit:observe-z",
      "commit:plan-a",
      "commit:plan-z",
    ]);
    expect(report.systems.map(({ systemId }) => systemId)).toEqual([
      "boot",
      "observe-mandatory",
      "observe-z",
      "plan-a",
      "plan-z",
    ]);
  });

  it("isolates a failed staged commit, invokes discard, and continues later systems", () => {
    const events: string[] = [];
    const cpu = new TestCpu();
    const failing = makeSystem("failing", {}, () => ({
      commit: () => {
        events.push("commit:failing");
        throw new Error("commit rejected");
      },
      discard: (fault) => events.push(`discard:${fault.stage}`),
    }));
    const later = makeSystem("later", { phase: "execute" }, () => ({
      commit: () => events.push("commit:later"),
    }));
    const kernel = new RuntimeKernel([later, failing]);

    const report = kernel.run({ tick: 7, context: { cpu, events }, cpu, inputRevision: "world-7" });

    expect(events).toEqual(["commit:failing", "discard:commit", "commit:later"]);
    expect(report.systems[0]).toMatchObject({
      systemId: "failing",
      status: "failed",
      fault: {
        stage: "commit",
        inputRevision: "world-7",
        error: { name: "Error", message: "commit rejected" },
      },
    });
    expect(report.systems[1]).toMatchObject({ systemId: "later", status: "completed" });
  });

  it("degrades after a mandatory fault but still executes every mandatory tail system", () => {
    const cpu = new TestCpu();
    const events: string[] = [];
    const mandatoryFailure = makeSystem(
      "safety",
      { phase: "safety", criticality: "mandatory" },
      () => {
        throw new Error("safety fault");
      },
    );
    const planner = makeSystem("planner", { phase: "plan" });
    const reconcile = makeSystem(
      "commit-tail",
      {
        phase: "reconcile",
        criticality: "mandatory",
        mandatoryTail: true,
      },
      () => ({ commit: () => events.push("commit:tail") }),
    );
    const telemetry = makeSystem(
      "telemetry-tail",
      {
        phase: "telemetry",
        criticality: "mandatory",
        mandatoryTail: true,
      },
      () => ({ commit: () => events.push("commit:telemetry") }),
    );
    const kernel = new RuntimeKernel([telemetry, planner, reconcile, mandatoryFailure]);

    const report = kernel.run({ tick: 10, context: { cpu, events }, cpu });

    expect(report.degraded).toBe(true);
    expect(report.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemId: "planner", skipReason: "degraded-after-fault" }),
        expect.objectContaining({ systemId: "commit-tail", status: "completed" }),
        expect.objectContaining({ systemId: "telemetry-tail", status: "completed" }),
      ]),
    );
    expect(events).toEqual(["commit:tail", "commit:telemetry"]);
  });

  it("quarantines repeated optional faults, backs off probes, and recovers on success", () => {
    const cpu = new TestCpu();
    const events: string[] = [];
    let shouldFail = true;
    const unstable = makeSystem("unstable", {}, ({ probe }) => {
      events.push(probe ? "probe" : "full");
      if (shouldFail) {
        throw new Error("planner fault");
      }
      return { commit: () => events.push("recovered") };
    });
    const kernel = new RuntimeKernel([unstable], {
      quarantinePolicy: {
        failuresBeforeQuarantine: 2,
        baseProbeDelay: 2,
        maximumProbeDelay: 16,
      },
    });
    const context = { cpu, events };

    expect(kernel.run({ tick: 1, context, cpu }).systems[0]?.status).toBe("failed");
    expect(kernel.run({ tick: 2, context, cpu }).systems[0]).toMatchObject({
      status: "failed",
      nextEligibleTick: 4,
    });
    expect(kernel.run({ tick: 3, context, cpu }).systems[0]).toMatchObject({
      status: "skipped",
      skipReason: "quarantined",
      nextEligibleTick: 4,
    });
    expect(kernel.run({ tick: 4, context, cpu }).systems[0]).toMatchObject({
      status: "failed",
      probe: true,
      nextEligibleTick: 8,
    });
    expect(kernel.run({ tick: 7, context, cpu }).systems[0]?.skipReason).toBe("quarantined");

    shouldFail = false;
    expect(kernel.run({ tick: 8, context, cpu }).systems[0]).toMatchObject({
      status: "completed",
      probe: true,
    });
    expect(kernel.getHealthSnapshot()).toEqual([
      {
        systemId: "unstable",
        consecutiveFailures: 0,
        lastSuccessfulTick: 8,
        nextProbeTick: null,
      },
    ]);
    expect(events).toEqual(["full", "full", "probe", "probe", "recovered"]);
  });

  it("restores valid known health while ignoring retired, malformed, and duplicate records", () => {
    const known = makeSystem("known");
    const invalid = makeSystem("invalid");
    const initialHealth = [
      {
        systemId: "retired.system",
        consecutiveFailures: -10,
        lastSuccessfulTick: Number.NaN,
        nextProbeTick: null,
      },
      {
        systemId: "known",
        consecutiveFailures: -1,
        lastSuccessfulTick: 3,
        nextProbeTick: null,
      },
      {
        systemId: "known",
        consecutiveFailures: 2,
        lastSuccessfulTick: 4,
        nextProbeTick: 10,
      },
      {
        systemId: "known",
        consecutiveFailures: 7,
        lastSuccessfulTick: 8,
        nextProbeTick: 20,
      },
      {
        systemId: "invalid",
        consecutiveFailures: Number.MAX_SAFE_INTEGER,
        lastSuccessfulTick: 5,
        nextProbeTick: null,
      },
      null,
    ] as unknown as readonly SystemHealthRecord[];

    const kernel = new RuntimeKernel([invalid, known], { initialHealth });

    expect(kernel.getHealthSnapshot()).toEqual([
      {
        systemId: "invalid",
        consecutiveFailures: 0,
        lastSuccessfulTick: null,
        nextProbeTick: null,
      },
      {
        systemId: "known",
        consecutiveFailures: 2,
        lastSuccessfulTick: 4,
        nextProbeTick: 10,
      },
    ]);
  });

  it("enforces cadence and permits an explicit, attributable wake", () => {
    const cpu = new TestCpu();
    const events: string[] = [];
    const periodic = makeSystem("periodic", { cadence: 3 }, ({ wakeReason }) => ({
      commit: () => events.push(wakeReason ?? "scheduled"),
    }));
    const kernel = new RuntimeKernel([periodic]);
    const context = { cpu, events };

    expect(kernel.run({ tick: 1, context, cpu }).systems[0]?.status).toBe("completed");
    expect(kernel.run({ tick: 2, context, cpu }).systems[0]).toMatchObject({
      skipReason: "cadence",
      nextEligibleTick: 4,
    });
    expect(
      kernel.run({
        tick: 2,
        context,
        cpu,
        wakeReasons: { periodic: "snapshot-dirty" },
      }).systems[0],
    ).toMatchObject({ status: "completed", wakeReason: "snapshot-dirty" });
    expect(events).toEqual(["scheduled", "snapshot-dirty"]);
  });

  it("accounts CPU per system and phase from the centralized meter", () => {
    const cpu = new TestCpu();
    const consume = (id: string, amount: number) =>
      makeSystem(id, { phase: "plan", estimate: amount }, ({ context }) => {
        context.cpu.consume(amount);
        return { commit: () => undefined };
      });
    const { report } = runOnce([consume("one", 1.25), consume("two", 2.5)], cpu);

    expect(report.systems.map(({ cpuUsed }) => cpuUsed)).toEqual([1.25, 2.5]);
    expect(report.phases.find(({ phase }) => phase === "plan")).toMatchObject({
      cpuUsed: 3.75,
      completed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(report.cpuUsed).toBe(3.75);
  });

  it("includes pre-kernel CPU in overhead while preserving the accounting identity", () => {
    const cpu = new TestCpu();
    cpu.consume(3);
    const measured = makeSystem("measured", { estimate: 2 }, ({ context }) => {
      context.cpu.consume(2);
      return { commit: () => undefined };
    });
    const kernel = new RuntimeKernel([measured]);

    const report = kernel.run({
      tick: 1,
      context: { cpu, events: [] },
      cpu,
      tickStartedAtCpu: 0,
    });
    const systemCpu = report.systems.reduce((total, system) => total + system.cpuUsed, 0);

    expect(report.cpu.usedAtStart).toBe(0);
    expect(report.cpuUsed).toBe(5);
    expect(report.overheadCpu).toBe(3);
    expect(systemCpu + report.overheadCpu).toBe(report.cpuUsed);
  });

  it("reserves the ordinary ceiling while admitting mandatory tail work", () => {
    const cpu = new TestCpu(6_000, 10, 10);
    const ordinary = makeSystem("ordinary", { estimate: 8 });
    const tail = makeSystem("tail", {
      phase: "telemetry",
      criticality: "mandatory",
      estimate: 2,
      mandatoryTail: true,
    });
    const { report, events } = runOnce([ordinary, tail], cpu, 1, {
      cpuPolicy: { mandatoryTailReserve: 3 },
    });

    expect(report.systems[0]).toMatchObject({
      systemId: "ordinary",
      status: "skipped",
      skipReason: "tail-reserve",
      budgetAvailable: 7,
    });
    expect(report.systems[1]).toMatchObject({ systemId: "tail", status: "completed" });
    expect(events).toEqual(["commit:tail"]);
  });

  it("reserves aggregate CPU for execute, reconcile, and telemetry in phase order", () => {
    const cpu = new TestCpu(6_000, 10, 10);
    const consumingSystem = (
      id: string,
      phase: "plan" | "execute" | "reconcile" | "telemetry",
      amount: number,
      mandatoryTail: boolean,
    ) =>
      makeSystem(
        id,
        {
          phase,
          criticality: mandatoryTail ? "mandatory" : "economic",
          estimate: amount,
          mandatoryTail,
        },
        ({ context }) => {
          context.cpu.consume(amount);
          return { commit: () => context.events.push(`commit:${id}`) };
        },
      );
    const systems = [
      consumingSystem("plan", "plan", 7, false),
      consumingSystem("execute", "execute", 1, true),
      consumingSystem("reconcile", "reconcile", 1, true),
      consumingSystem("telemetry", "telemetry", 1, true),
    ];

    const { events, report } = runOnce(systems, cpu, 1, {
      cpuPolicy: { mandatoryTailReserve: 3 },
    });

    expect(events).toEqual([
      "commit:plan",
      "commit:execute",
      "commit:reconcile",
      "commit:telemetry",
    ]);
    expect(report.systems.map(({ budgetAvailable }) => budgetAvailable)).toEqual([7, 1, 1, 1]);
    expect(report.systems.every(({ status }) => status === "completed")).toBe(true);
  });

  it("discards a staged result without committing when run exceeds its budget", () => {
    const cpu = new TestCpu(6_000, 10, 10);
    const events: string[] = [];
    const system = makeSystem("overrun", { estimate: 1 }, ({ context }) => {
      context.cpu.consume(6);
      return {
        commit: () => events.push("commit"),
        discard: (fault) => events.push(`discard:${fault.stage}`),
      };
    });
    const kernel = new RuntimeKernel([system]);

    const report = kernel.run({ tick: 1, context: { cpu, events }, cpu });

    expect(events).toEqual(["discard:budget"]);
    expect(report.systems[0]).toMatchObject({
      status: "failed",
      overrun: true,
      fault: { stage: "budget" },
    });
  });

  it("contains malformed staged results and still reaches mandatory telemetry", () => {
    const cpu = new TestCpu();
    const events: string[] = [];
    const malformed = makeSystem("malformed", {}, () => undefined as never);
    const telemetry = makeSystem(
      "telemetry",
      { phase: "telemetry", criticality: "mandatory", mandatoryTail: true },
      () => ({ commit: () => events.push("telemetry") }),
    );
    const kernel = new RuntimeKernel([telemetry, malformed]);

    const report = kernel.run({ tick: 1, context: { cpu, events }, cpu });

    expect(report.systems[0]).toMatchObject({ status: "failed", fault: { stage: "run" } });
    expect(report.systems[1]).toMatchObject({ status: "completed" });
    expect(events).toEqual(["telemetry"]);
  });

  it("snapshots descriptors and orders due deadlines before explicit wakes", () => {
    const cpu = new TestCpu();
    const events: string[] = [];
    const mutable = makeDescriptor("mutable", { phase: "plan" });
    const unused = makeSystem("unused");
    const systems = [
      makeSystem("woken", {}, ({ context }) => ({
        commit: () => context.events.push("woken"),
      })),
      makeSystem("deadline", {}, ({ context }) => ({
        commit: () => context.events.push("deadline"),
      })),
      {
        descriptor: mutable,
        run: (scope: SystemRunScope<TestContext>) => unused.run(scope),
      },
    ];
    const kernel = new RuntimeKernel(systems);
    (mutable as { id: string }).id = "changed-after-registration";

    const report = kernel.run({
      tick: 5,
      context: { cpu, events },
      cpu,
      deadlines: { deadline: 5 },
      wakeReasons: { woken: "dirty" },
    });

    expect(report.systems.map(({ systemId }) => systemId)).toEqual([
      "deadline",
      "woken",
      "mutable",
    ]);
  });
});

describe("CpuScheduler", () => {
  const policy: Partial<CpuPolicy> = {
    emergencyBucketBelow: 20,
    constrainedBucketBelow: 40,
    surplusBucketAt: 80,
    constrainedRecentUsageAt: 0.9,
    surplusRecentUsageAtMost: 0.5,
    mandatoryTailReserve: 2,
    bucketHysteresis: 2,
    recentUsageHysteresis: 0.05,
  };

  it("derives all five modes from one snapshot plus explicit runtime signals", () => {
    const scheduler = new CpuScheduler(policy);

    expect(scheduler.startTick(new TestCpu(60), { recoveryRequired: true }).mode).toBe("recovery");
    expect(scheduler.startTick(new TestCpu(60), { activeThreat: true }).mode).toBe("emergency");
    expect(scheduler.startTick(new TestCpu(10)).mode).toBe("emergency");
    expect(scheduler.startTick(new TestCpu(30)).mode).toBe("constrained");
    expect(scheduler.startTick(new TestCpu(60), { recentUsageRatio: 0.95 }).mode).toBe(
      "constrained",
    );
    expect(scheduler.startTick(new TestCpu(60)).mode).toBe("normal");
    expect(scheduler.startTick(new TestCpu(90), { recentUsageRatio: 0.4 }).mode).toBe("surplus");
  });

  it.each([
    ["recovery", 60, { recoveryRequired: true }, ["mandatory", "recovery-essential"]],
    ["emergency", 10, {}, ["mandatory"]],
    ["constrained", 30, {}, ["mandatory", "operational", "recovery-essential"]],
    ["normal", 60, {}, ["mandatory", "operational", "recovery-essential", "economic", "strategic"]],
    [
      "surplus",
      90,
      {},
      ["mandatory", "operational", "recovery-essential", "economic", "strategic", "maintenance"],
    ],
  ] as const)("admits the documented %s workload classes", (expectedMode, bucket, signals, ids) => {
    const systems = [
      makeSystem("mandatory", { criticality: "mandatory" }),
      makeSystem("recovery-essential", {
        criticality: "operational",
        admitInRecovery: true,
      }),
      makeSystem("operational", { criticality: "operational" }),
      makeSystem("economic", { criticality: "economic" }),
      makeSystem("strategic", { criticality: "strategic" }),
      makeSystem("maintenance", { criticality: "maintenance" }),
    ];
    const { report } = runOnce(systems, new TestCpu(bucket), 1, {
      cpuPolicy: policy,
      signals,
    });

    expect(report.mode).toBe(expectedMode);
    expect(
      report.systems.filter(({ status }) => status === "completed").map(({ systemId }) => systemId),
    ).toEqual(ids);
    expect(
      report.systems
        .filter(({ status }) => status === "skipped")
        .every(({ skipReason }) => skipReason === "cpu-mode"),
    ).toBe(true);
  });

  it("captures mutable CPU properties once for mode selection", () => {
    let bucketReads = 0;
    let limitReads = 0;
    let tickLimitReads = 0;
    const source: CpuSource = {
      get bucket() {
        bucketReads += 1;
        return 60;
      },
      get limit() {
        limitReads += 1;
        return 20;
      },
      get tickLimit() {
        tickLimitReads += 1;
        return 100;
      },
      getUsed: () => 0,
    };
    const scheduler = new CpuScheduler(policy);

    const tick = scheduler.startTick(source);

    expect(tick.mode).toBe("normal");
    expect(tick.snapshot).toEqual({ bucket: 60, limit: 20, tickLimit: 100, usedAtStart: 0 });
    expect({ bucketReads, limitReads, tickLimitReads }).toEqual({
      bucketReads: 1,
      limitReads: 1,
      tickLimitReads: 1,
    });
  });

  it("uses hysteresis to avoid mode flapping at bucket boundaries", () => {
    const scheduler = new CpuScheduler(policy);

    expect(scheduler.startTick(new TestCpu(19)).mode).toBe("emergency");
    expect(scheduler.startTick(new TestCpu(21)).mode).toBe("emergency");
    expect(scheduler.startTick(new TestCpu(22)).mode).toBe("constrained");
    expect(scheduler.startTick(new TestCpu(39)).mode).toBe("constrained");
    expect(scheduler.startTick(new TestCpu(41)).mode).toBe("constrained");
    expect(scheduler.startTick(new TestCpu(42)).mode).toBe("normal");
  });
});
