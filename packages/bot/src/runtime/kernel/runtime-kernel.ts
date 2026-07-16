import {
  KERNEL_PHASES,
  SYSTEM_CRITICALITIES,
  type CompactError,
  type CpuMode,
  type KernelPhase,
  type KernelTickReport,
  type KernelTickRequest,
  type PhaseExecutionReport,
  type QuarantinePolicy,
  type SystemDescriptor,
  type SystemExecutionReport,
  type SystemFault,
  type SystemFaultStage,
  type SystemHealthRecord,
  type SystemSkipReason,
  type TickSystem,
} from "./contracts";
import { CpuScheduler, type CpuPolicy } from "./cpu-scheduler";

export const DEFAULT_QUARANTINE_POLICY: Readonly<QuarantinePolicy> = Object.freeze({
  failuresBeforeQuarantine: 2,
  baseProbeDelay: 2,
  maximumProbeDelay: 128,
  maximumFailureCount: 16,
});

export interface RuntimeKernelConfig {
  readonly cpuPolicy?: Partial<CpuPolicy>;
  readonly quarantinePolicy?: Partial<QuarantinePolicy>;
  readonly initialHealth?: readonly SystemHealthRecord[];
  readonly initialCpuMode?: CpuMode | null;
}

interface MutableSystemHealth {
  consecutiveFailures: number;
  lastSuccessfulTick: number | null;
  nextProbeTick: number | null;
}

interface MutablePhaseReport {
  cpuUsed: number;
  completed: number;
  failed: number;
  skipped: number;
}

const PHASE_ORDER = new Map<KernelPhase, number>(
  KERNEL_PHASES.map((phase, index) => [phase, index]),
);

const CRITICALITY_ORDER = new Map(
  SYSTEM_CRITICALITIES.map((criticality, index) => [criticality, index]),
);

function integerAtLeast(value: number, minimum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${String(minimum)}`);
  }

  return value;
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }

  return value;
}

function validateDescriptor(descriptor: SystemDescriptor): void {
  if (
    descriptor.id.trim() === "" ||
    descriptor.id !== descriptor.id.trim() ||
    descriptor.id.length > 128
  ) {
    throw new Error("system id must be non-empty, trimmed, and at most 128 characters");
  }

  if (!PHASE_ORDER.has(descriptor.phase)) {
    throw new Error(`system ${descriptor.id} has an unknown phase`);
  }

  if (!CRITICALITY_ORDER.has(descriptor.criticality)) {
    throw new Error(`system ${descriptor.id} has an unknown criticality`);
  }

  integerAtLeast(descriptor.cadence, 1, `system ${descriptor.id} cadence`);
  finiteNonNegative(descriptor.estimate, `system ${descriptor.id} estimate`);
  if (
    typeof descriptor.admitInRecovery !== "boolean" ||
    typeof descriptor.mandatoryTail !== "boolean"
  ) {
    throw new Error(`system ${descriptor.id} flags must be boolean`);
  }

  if (descriptor.mandatoryTail) {
    if (descriptor.criticality !== "mandatory") {
      throw new Error(`mandatory tail system ${descriptor.id} must be mandatory`);
    }

    if (descriptor.cadence !== 1) {
      throw new Error(`mandatory tail system ${descriptor.id} must run every tick`);
    }

    if (
      descriptor.phase !== "execute" &&
      descriptor.phase !== "reconcile" &&
      descriptor.phase !== "telemetry"
    ) {
      throw new Error(
        `mandatory tail system ${descriptor.id} must run in execute, reconcile, or telemetry`,
      );
    }
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeSystem<Context>(system: TickSystem<Context>): TickSystem<Context> {
  validateDescriptor(system.descriptor);
  if (typeof system.run !== "function") {
    throw new Error(`system ${system.descriptor.id} run must be a function`);
  }

  const descriptor = Object.freeze({ ...system.descriptor });
  const run = system.run.bind(system);
  return Object.freeze({
    descriptor,
    run,
  });
}

function validateQuarantinePolicy(policy: QuarantinePolicy): void {
  integerAtLeast(policy.failuresBeforeQuarantine, 1, "failuresBeforeQuarantine");
  integerAtLeast(policy.baseProbeDelay, 1, "baseProbeDelay");
  integerAtLeast(policy.maximumProbeDelay, 1, "maximumProbeDelay");
  integerAtLeast(policy.maximumFailureCount, 1, "maximumFailureCount");

  if (policy.baseProbeDelay > policy.maximumProbeDelay) {
    throw new Error("baseProbeDelay must not exceed maximumProbeDelay");
  }

  if (policy.failuresBeforeQuarantine > policy.maximumFailureCount) {
    throw new Error("failuresBeforeQuarantine must not exceed maximumFailureCount");
  }
}

function compactError(error: unknown): CompactError {
  void error;
  return Object.freeze({ name: "RuntimeFault", message: "unexpected-exception" });
}

function makeFault(
  descriptor: SystemDescriptor,
  tick: number,
  stage: SystemFaultStage,
  error: unknown,
  inputRevision: string | null,
): SystemFault {
  return Object.freeze({
    systemId: descriptor.id,
    phase: descriptor.phase,
    tick,
    stage,
    error: compactError(error),
    inputRevision,
  });
}

interface PreparedStagedResult {
  commit(): void;
  discard?: (fault: SystemFault) => void;
}

function prepareStagedResult(value: unknown): PreparedStagedResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("system run must return a staged result object");
  }

  const candidate = value as { readonly commit?: unknown; readonly discard?: unknown };
  const commit = candidate.commit;
  const discard = candidate.discard;
  if (typeof commit !== "function") {
    throw new TypeError("staged result commit must be a function");
  }
  if (discard !== undefined && typeof discard !== "function") {
    throw new TypeError("staged result discard must be a function when provided");
  }

  return {
    commit(): void {
      assertSynchronous(commit.call(value), "commit");
    },
    ...(discard === undefined
      ? {}
      : {
          discard(fault: SystemFault): void {
            assertSynchronous(discard.call(value, fault), "discard");
          },
        }),
  };
}

function assertSynchronous(value: unknown, operation: string): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return;
  }

  let then: unknown;
  try {
    then = (value as { readonly then?: unknown }).then;
  } catch {
    throw new TypeError(`staged result ${operation} returned an unreadable thenable`);
  }
  if (typeof then === "function") {
    throw new TypeError(`staged result ${operation} must be synchronous`);
  }
}

function emptyHealth(): MutableSystemHealth {
  return {
    consecutiveFailures: 0,
    lastSuccessfulTick: null,
    nextProbeTick: null,
  };
}

function freezePhaseReports(
  reports: ReadonlyMap<KernelPhase, MutablePhaseReport>,
): readonly PhaseExecutionReport[] {
  return KERNEL_PHASES.map((phase) => {
    const report = reports.get(phase);
    if (report === undefined) {
      throw new Error(`missing phase report for ${phase}`);
    }

    return Object.freeze({ phase, ...report });
  });
}

function skipReport(
  descriptor: SystemDescriptor,
  reason: SystemSkipReason,
  probe: boolean,
  wakeReason: string | null,
  deadline: number | null,
  nextEligibleTick: number | null,
  budgetAvailable = 0,
): SystemExecutionReport {
  return Object.freeze({
    systemId: descriptor.id,
    phase: descriptor.phase,
    criticality: descriptor.criticality,
    status: "skipped",
    cpuUsed: 0,
    estimate: descriptor.estimate,
    budgetAvailable,
    probe,
    wakeReason,
    deadline,
    skipReason: reason,
    nextEligibleTick,
    estimateError: null,
    overrun: false,
    fault: null,
    discardFault: null,
  });
}

export class RuntimeKernel<Context> {
  private readonly systems: readonly TickSystem<Context>[];
  private readonly scheduler: CpuScheduler;
  private readonly quarantinePolicy: Readonly<QuarantinePolicy>;
  private readonly health = new Map<string, MutableSystemHealth>();

  public constructor(systems: readonly TickSystem<Context>[], config: RuntimeKernelConfig = {}) {
    const ids = new Set<string>();
    const normalizedSystems = systems.map((system) => normalizeSystem(system));
    for (const system of normalizedSystems) {
      if (ids.has(system.descriptor.id)) {
        throw new Error(`duplicate system id: ${system.descriptor.id}`);
      }
      ids.add(system.descriptor.id);
    }

    this.systems = Object.freeze(normalizedSystems);
    this.scheduler = new CpuScheduler(config.cpuPolicy, config.initialCpuMode);
    const registeredTailEstimate = this.systems
      .filter(({ descriptor }) => descriptor.mandatoryTail)
      .reduce((total, { descriptor }) => total + descriptor.estimate, 0);
    if (registeredTailEstimate > this.scheduler.policy.mandatoryTailReserve) {
      throw new Error(
        `mandatory tail estimates require ${registeredTailEstimate.toFixed(3)} CPU but only ` +
          `${this.scheduler.policy.mandatoryTailReserve.toFixed(3)} CPU is reserved`,
      );
    }

    const quarantinePolicy: QuarantinePolicy = {
      ...DEFAULT_QUARANTINE_POLICY,
      ...config.quarantinePolicy,
    };
    validateQuarantinePolicy(quarantinePolicy);
    this.quarantinePolicy = Object.freeze(quarantinePolicy);

    for (const system of this.systems) {
      this.health.set(system.descriptor.id, emptyHealth());
    }

    this.restoreHealth(config.initialHealth ?? []);
  }

  public getHealthSnapshot(): readonly SystemHealthRecord[] {
    return [...this.health.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([systemId, health]) =>
        Object.freeze({
          systemId,
          consecutiveFailures: health.consecutiveFailures,
          lastSuccessfulTick: health.lastSuccessfulTick,
          nextProbeTick: health.nextProbeTick,
        }),
      );
  }

  public run(request: KernelTickRequest<Context>): KernelTickReport {
    integerAtLeast(request.tick, 0, "tick");
    const wakeReasons = request.wakeReasons ?? {};
    const deadlines = request.deadlines ?? {};
    this.validateWakeReasons(wakeReasons);
    this.validateDeadlines(deadlines);

    const cpuTick = this.scheduler.startTick(
      request.cpu,
      request.signals,
      request.tickStartedAtCpu,
    );
    const inputRevision = request.inputRevision ?? null;
    const systemReports: SystemExecutionReport[] = [];
    const faults: SystemFault[] = [];
    const phaseReports = new Map<KernelPhase, MutablePhaseReport>(
      KERNEL_PHASES.map((phase) => [phase, { cpuUsed: 0, completed: 0, failed: 0, skipped: 0 }]),
    );
    const orderedSystems = this.orderedSystems(wakeReasons, deadlines);
    const reservedAfterSystem = this.reservedCpuAfterSystems(orderedSystems);
    let degraded = false;
    for (const system of orderedSystems) {
      const descriptor = system.descriptor;
      const health = this.getMutableHealth(descriptor.id);
      const wakeReason = wakeReasons[descriptor.id] ?? null;
      const deadline = deadlines[descriptor.id] ?? null;
      const probe = health.nextProbeTick !== null && request.tick >= health.nextProbeTick;

      const preAdmissionSkip = this.preAdmissionSkip(
        descriptor,
        health,
        request.tick,
        wakeReason,
        deadline,
        probe,
        degraded,
      );
      if (preAdmissionSkip !== null) {
        this.recordReport(systemReports, phaseReports, preAdmissionSkip);
        continue;
      }

      const startCpu = finiteNonNegative(request.cpu.getUsed(), "cpu.getUsed()");
      const admission = cpuTick.admit(
        descriptor,
        startCpu,
        reservedAfterSystem.get(descriptor.id) ?? 0,
      );
      if (!admission.admitted && admission.reason !== null) {
        const report = skipReport(
          descriptor,
          admission.reason,
          probe,
          wakeReason,
          deadline,
          null,
          admission.budget.available,
        );
        this.recordReport(systemReports, phaseReports, report);
        continue;
      }

      let staged: PreparedStagedResult | null = null;
      let fault: SystemFault | null = null;
      let discardFault: SystemFault | null = null;

      try {
        staged = prepareStagedResult(
          system.run({
            context: request.context,
            tick: request.tick,
            cpu: cpuTick.snapshot,
            mode: cpuTick.mode,
            budget: admission.budget,
            probe,
            wakeReason,
          }),
        );
      } catch (error: unknown) {
        fault = makeFault(descriptor, request.tick, "run", error, inputRevision);
      }

      const afterRunCpu = finiteNonNegative(request.cpu.getUsed(), "cpu.getUsed()");
      const runCpuUsed = Math.max(0, afterRunCpu - startCpu);
      if (fault === null && runCpuUsed > admission.budget.available) {
        fault = this.budgetFault(
          descriptor,
          request.tick,
          runCpuUsed,
          admission.budget.available,
          inputRevision,
        );
      }

      if (fault === null && staged !== null) {
        try {
          staged.commit();
        } catch (error: unknown) {
          fault = makeFault(descriptor, request.tick, "commit", error, inputRevision);
        }
      }

      let endCpu = finiteNonNegative(request.cpu.getUsed(), "cpu.getUsed()");
      let cpuUsed = Math.max(0, endCpu - startCpu);
      if (fault === null && cpuUsed > admission.budget.available) {
        fault = this.budgetFault(
          descriptor,
          request.tick,
          cpuUsed,
          admission.budget.available,
          inputRevision,
        );
      }

      if (fault !== null && staged?.discard !== undefined) {
        try {
          staged.discard(fault);
        } catch (error: unknown) {
          discardFault = makeFault(descriptor, request.tick, "discard", error, inputRevision);
        }
      }

      endCpu = finiteNonNegative(request.cpu.getUsed(), "cpu.getUsed()");
      cpuUsed = Math.max(0, endCpu - startCpu);

      if (fault === null) {
        this.recordSuccess(health, request.tick);
      } else {
        faults.push(fault);
        this.recordFailure(descriptor, health, request.tick);
        if (descriptor.criticality === "mandatory") {
          degraded = true;
        }
      }

      if (discardFault !== null) {
        faults.push(discardFault);
      }

      const report: SystemExecutionReport = Object.freeze({
        systemId: descriptor.id,
        phase: descriptor.phase,
        criticality: descriptor.criticality,
        status: fault === null ? "completed" : "failed",
        cpuUsed,
        estimate: descriptor.estimate,
        budgetAvailable: admission.budget.available,
        probe,
        wakeReason,
        deadline,
        skipReason: null,
        nextEligibleTick: health.nextProbeTick,
        estimateError: cpuUsed - descriptor.estimate,
        overrun: fault?.stage === "budget",
        fault,
        discardFault,
      });
      this.recordReport(systemReports, phaseReports, report);
    }

    // Prepare every potentially material report collection before taking the final meter reading.
    // Only the constant-size outer report assembly remains after this accounting boundary.
    const systems = Object.freeze(systemReports);
    const phases = Object.freeze(freezePhaseReports(phaseReports));
    const frozenFaults = Object.freeze(faults);
    const attributedCpu = systems.reduce((total, report) => total + report.cpuUsed, 0);
    const endCpu = finiteNonNegative(request.cpu.getUsed(), "cpu.getUsed()");
    const cpuUsed = Math.max(0, endCpu - cpuTick.snapshot.usedAtStart);
    return Object.freeze({
      tick: request.tick,
      mode: cpuTick.mode,
      cpu: cpuTick.snapshot,
      cpuUsed,
      overheadCpu: Math.max(0, cpuUsed - attributedCpu),
      degraded,
      systems,
      phases,
      faults: frozenFaults,
    });
  }

  private restoreHealth(records: readonly SystemHealthRecord[]): void {
    const restored = new Set<string>();
    for (const value of records as readonly unknown[]) {
      const record = this.parseRestoredHealth(value);
      if (record === null) {
        continue;
      }
      const health = this.health.get(record.systemId);
      // A deploy may retire or rename a system. Its bounded history is optional derived state.
      // Duplicate records are equally non-authoritative: the first valid record wins.
      if (health === undefined || restored.has(record.systemId)) {
        continue;
      }
      restored.add(record.systemId);

      health.consecutiveFailures = record.consecutiveFailures;
      health.lastSuccessfulTick = record.lastSuccessfulTick;
      health.nextProbeTick = record.nextProbeTick;
    }
  }

  private parseRestoredHealth(value: unknown): (SystemHealthRecord & MutableSystemHealth) | null {
    if (typeof value !== "object" || value === null) {
      return null;
    }

    const candidate = value as Partial<SystemHealthRecord>;
    if (
      typeof candidate.systemId !== "string" ||
      !Number.isSafeInteger(candidate.consecutiveFailures) ||
      (candidate.consecutiveFailures ?? -1) < 0 ||
      (candidate.consecutiveFailures ?? 0) > this.quarantinePolicy.maximumFailureCount ||
      !this.isNullableTick(candidate.lastSuccessfulTick) ||
      !this.isNullableTick(candidate.nextProbeTick)
    ) {
      return null;
    }

    return {
      systemId: candidate.systemId,
      consecutiveFailures: candidate.consecutiveFailures as number,
      lastSuccessfulTick: candidate.lastSuccessfulTick,
      nextProbeTick: candidate.nextProbeTick,
    };
  }

  private isNullableTick(value: unknown): value is number | null {
    return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
  }

  private validateWakeReasons(wakeReasons: Readonly<Record<string, string>>): void {
    for (const [systemId, reason] of Object.entries(wakeReasons)) {
      if (!this.health.has(systemId)) {
        throw new Error(`wake reason references unknown system: ${systemId}`);
      }
      if (reason.trim() === "") {
        throw new Error(`wake reason for ${systemId} must not be empty`);
      }
    }
  }

  private validateDeadlines(deadlines: Readonly<Record<string, number>>): void {
    for (const [systemId, deadline] of Object.entries(deadlines)) {
      if (!this.health.has(systemId)) {
        throw new Error(`deadline references unknown system: ${systemId}`);
      }
      integerAtLeast(deadline, 0, `deadline for ${systemId}`);
    }
  }

  private orderedSystems(
    wakeReasons: Readonly<Record<string, string>>,
    deadlines: Readonly<Record<string, number>>,
  ): readonly TickSystem<Context>[] {
    return [...this.systems].sort((left, right) => {
      const phaseDifference =
        (PHASE_ORDER.get(left.descriptor.phase) ?? 0) -
        (PHASE_ORDER.get(right.descriptor.phase) ?? 0);
      if (phaseDifference !== 0) {
        return phaseDifference;
      }

      if (left.descriptor.mandatoryTail !== right.descriptor.mandatoryTail) {
        return left.descriptor.mandatoryTail ? 1 : -1;
      }

      const criticalityDifference =
        (CRITICALITY_ORDER.get(left.descriptor.criticality) ?? 0) -
        (CRITICALITY_ORDER.get(right.descriptor.criticality) ?? 0);
      if (criticalityDifference !== 0) {
        return criticalityDifference;
      }

      const leftDeadline = deadlines[left.descriptor.id] ?? null;
      const rightDeadline = deadlines[right.descriptor.id] ?? null;
      if (leftDeadline !== rightDeadline) {
        if (leftDeadline === null) {
          return 1;
        }
        if (rightDeadline === null) {
          return -1;
        }
        return leftDeadline - rightDeadline;
      }

      const leftWoken = wakeReasons[left.descriptor.id] !== undefined;
      const rightWoken = wakeReasons[right.descriptor.id] !== undefined;
      if (leftWoken !== rightWoken) {
        return leftWoken ? -1 : 1;
      }

      const leftHealth = this.getMutableHealth(left.descriptor.id);
      const rightHealth = this.getMutableHealth(right.descriptor.id);
      const leftDue =
        leftHealth.lastSuccessfulTick === null
          ? Number.NEGATIVE_INFINITY
          : leftHealth.lastSuccessfulTick + left.descriptor.cadence;
      const rightDue =
        rightHealth.lastSuccessfulTick === null
          ? Number.NEGATIVE_INFINITY
          : rightHealth.lastSuccessfulTick + right.descriptor.cadence;
      if (leftDue !== rightDue) {
        return leftDue - rightDue;
      }

      return compareStrings(left.descriptor.id, right.descriptor.id);
    });
  }

  private reservedCpuAfterSystems(
    systems: readonly TickSystem<Context>[],
  ): ReadonlyMap<string, number> {
    const reservations = new Map<string, number>();
    let reserved = 0;
    for (let index = systems.length - 1; index >= 0; index -= 1) {
      const descriptor = systems[index]?.descriptor;
      if (descriptor?.mandatoryTail === true) {
        reservations.set(descriptor.id, reserved);
        reserved += descriptor.estimate;
      }
    }
    return reservations;
  }

  private preAdmissionSkip(
    descriptor: SystemDescriptor,
    health: MutableSystemHealth,
    tick: number,
    wakeReason: string | null,
    deadline: number | null,
    probe: boolean,
    degraded: boolean,
  ): SystemExecutionReport | null {
    if (descriptor.mandatoryTail) {
      return null;
    }

    if (degraded && descriptor.criticality !== "mandatory") {
      return skipReport(descriptor, "degraded-after-fault", probe, wakeReason, deadline, null);
    }

    if (health.nextProbeTick !== null && tick < health.nextProbeTick) {
      return skipReport(
        descriptor,
        "quarantined",
        false,
        wakeReason,
        deadline,
        health.nextProbeTick,
      );
    }

    if (
      !probe &&
      wakeReason === null &&
      (deadline === null || tick < deadline) &&
      health.lastSuccessfulTick !== null &&
      tick < health.lastSuccessfulTick + descriptor.cadence
    ) {
      return skipReport(
        descriptor,
        "cadence",
        false,
        null,
        deadline,
        health.lastSuccessfulTick + descriptor.cadence,
      );
    }

    return null;
  }

  private budgetFault(
    descriptor: SystemDescriptor,
    tick: number,
    used: number,
    available: number,
    inputRevision: string | null,
  ): SystemFault {
    return makeFault(
      descriptor,
      tick,
      "budget",
      new Error(`system used ${used.toFixed(3)} CPU with ${available.toFixed(3)} available`),
      inputRevision,
    );
  }

  private getMutableHealth(systemId: string): MutableSystemHealth {
    const health = this.health.get(systemId);
    if (health === undefined) {
      throw new Error(`missing health for system: ${systemId}`);
    }
    return health;
  }

  private recordSuccess(health: MutableSystemHealth, tick: number): void {
    health.consecutiveFailures = 0;
    health.lastSuccessfulTick = tick;
    health.nextProbeTick = null;
  }

  private recordFailure(
    descriptor: SystemDescriptor,
    health: MutableSystemHealth,
    tick: number,
  ): void {
    health.consecutiveFailures = Math.min(
      this.quarantinePolicy.maximumFailureCount,
      health.consecutiveFailures + 1,
    );

    if (
      descriptor.criticality === "mandatory" ||
      health.consecutiveFailures < this.quarantinePolicy.failuresBeforeQuarantine
    ) {
      health.nextProbeTick = null;
      return;
    }

    const exponent = health.consecutiveFailures - this.quarantinePolicy.failuresBeforeQuarantine;
    const delay = Math.min(
      this.quarantinePolicy.maximumProbeDelay,
      this.quarantinePolicy.baseProbeDelay * 2 ** exponent,
    );
    health.nextProbeTick = tick + delay;
  }

  private recordReport(
    systemReports: SystemExecutionReport[],
    phaseReports: Map<KernelPhase, MutablePhaseReport>,
    report: SystemExecutionReport,
  ): void {
    systemReports.push(report);
    const phase = phaseReports.get(report.phase);
    if (phase === undefined) {
      throw new Error(`missing phase report for ${report.phase}`);
    }

    phase.cpuUsed += report.cpuUsed;
    switch (report.status) {
      case "completed":
        phase.completed += 1;
        break;
      case "failed":
        phase.failed += 1;
        break;
      case "skipped":
        phase.skipped += 1;
        break;
    }
  }
}
