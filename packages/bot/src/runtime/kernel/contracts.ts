import { TICK_PHASES, type TickPhase } from "../phases";

/** The existing runtime phase declaration remains the single phase-order authority. */
export const KERNEL_PHASES = TICK_PHASES;

export type KernelPhase = TickPhase;

export const SYSTEM_CRITICALITIES = [
  "mandatory",
  "operational",
  "economic",
  "strategic",
  "maintenance",
] as const;

export type SystemCriticality = (typeof SYSTEM_CRITICALITIES)[number];

export const CPU_MODES = ["recovery", "emergency", "constrained", "normal", "surplus"] as const;

export type CpuMode = (typeof CPU_MODES)[number];

export interface CpuSource {
  readonly bucket: number;
  readonly limit: number;
  readonly tickLimit: number;
  getUsed(): number;
}

export interface CpuSnapshot {
  readonly bucket: number;
  readonly limit: number;
  readonly tickLimit: number;
  readonly usedAtStart: number;
}

export interface CpuSignals {
  readonly recoveryRequired?: boolean;
  readonly activeThreat?: boolean;
  readonly recentUsageRatio?: number;
}

export interface CpuBudget {
  /** CPU available when the system boundary was entered. */
  readonly available: number;
  /** The absolute Game.cpu.getUsed() ceiling for this admission class. */
  readonly hardCeiling: number;
  /** Static estimate declared by the system. */
  readonly estimate: number;
  /** CPU held back from ordinary work for mandatory tail systems. */
  readonly reservedForTail: number;
}

export interface SystemDescriptor {
  /** Globally unique, stable identifier used for ordering and health records. */
  readonly id: string;
  readonly phase: KernelPhase;
  /** Admission class; domain or business priority must not be encoded here. */
  readonly criticality: SystemCriticality;
  /** Minimum successful-run interval in ticks. */
  readonly cadence: number;
  /** Expected CPU for one complete run. */
  readonly estimate: number;
  /** Explicit exception for essential work while a migration/recovery is active. */
  readonly admitInRecovery: boolean;
  /** Reserved, unskippable execute/reconcile/telemetry work. */
  readonly mandatoryTail: boolean;
}

export interface CompactError {
  readonly name: string;
  readonly message: string;
}

export type SystemFaultStage = "run" | "commit" | "discard" | "budget";

export interface SystemFault {
  readonly systemId: string;
  readonly phase: KernelPhase;
  readonly tick: number;
  readonly stage: SystemFaultStage;
  readonly error: CompactError;
  readonly inputRevision: string | null;
}

/**
 * A system stages private output during `run`. The kernel is the sole caller of
 * `commit`; a failed boundary invokes `discard` when a staged result exists.
 */
export interface StagedSystemResult {
  commit(): void;
  discard?(fault: SystemFault): void;
}

export interface SystemRunScope<Context> {
  readonly context: Context;
  readonly tick: number;
  readonly cpu: CpuSnapshot;
  readonly mode: CpuMode;
  readonly budget: CpuBudget;
  readonly probe: boolean;
  readonly wakeReason: string | null;
}

export interface TickSystem<Context> {
  readonly descriptor: SystemDescriptor;
  run(scope: SystemRunScope<Context>): StagedSystemResult;
}

export type SystemSkipReason =
  "cadence" | "cpu-mode" | "tail-reserve" | "quarantined" | "degraded-after-fault";

export type SystemStatus = "completed" | "failed" | "skipped";

export interface SystemExecutionReport {
  readonly systemId: string;
  readonly phase: KernelPhase;
  readonly criticality: SystemCriticality;
  readonly status: SystemStatus;
  readonly cpuUsed: number;
  readonly estimate: number;
  readonly budgetAvailable: number;
  readonly probe: boolean;
  readonly wakeReason: string | null;
  readonly deadline: number | null;
  readonly skipReason: SystemSkipReason | null;
  readonly nextEligibleTick: number | null;
  readonly estimateError: number | null;
  readonly overrun: boolean;
  readonly fault: SystemFault | null;
  readonly discardFault: SystemFault | null;
}

export interface PhaseExecutionReport {
  readonly phase: KernelPhase;
  readonly cpuUsed: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface KernelTickReport {
  readonly tick: number;
  readonly mode: CpuMode;
  readonly cpu: CpuSnapshot;
  readonly cpuUsed: number;
  /** CPU consumed by bounded preflight and orchestration outside measured system boundaries. */
  readonly overheadCpu: number;
  readonly degraded: boolean;
  readonly systems: readonly SystemExecutionReport[];
  readonly phases: readonly PhaseExecutionReport[];
  readonly faults: readonly SystemFault[];
}

export interface KernelTickRequest<Context> {
  readonly tick: number;
  readonly context: Context;
  readonly cpu: CpuSource;
  /** CPU reading captured at the start of runTick, before bounded Memory preflight. */
  readonly tickStartedAtCpu?: number;
  readonly signals?: CpuSignals;
  /** Revision/hash of the immutable input snapshot, when one exists. */
  readonly inputRevision?: string;
  /** Explicit wake reasons bypass cadence but never CPU admission or quarantine. */
  readonly wakeReasons?: Readonly<Record<string, string>>;
  /** Per-system absolute deadlines. A reached deadline bypasses cadence, never admission. */
  readonly deadlines?: Readonly<Record<string, number>>;
}

export interface SystemHealthRecord {
  readonly systemId: string;
  readonly consecutiveFailures: number;
  readonly lastSuccessfulTick: number | null;
  readonly nextProbeTick: number | null;
}

export interface QuarantinePolicy {
  readonly failuresBeforeQuarantine: number;
  readonly baseProbeDelay: number;
  readonly maximumProbeDelay: number;
  readonly maximumFailureCount: number;
}
