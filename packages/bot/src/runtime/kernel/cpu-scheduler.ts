import type {
  CpuBudget,
  CpuMode,
  CpuSignals,
  CpuSnapshot,
  CpuSource,
  SystemDescriptor,
  SystemSkipReason,
} from "./contracts";

export interface CpuPolicy {
  /** Bucket levels below this value permit mandatory emergency work only. */
  readonly emergencyBucketBelow: number;
  /** Bucket levels below this value constrain work to mandatory/operational systems. */
  readonly constrainedBucketBelow: number;
  /** Surplus work is considered only at or above this bucket level. */
  readonly surplusBucketAt: number;
  /** A bounded recent-use signal at or above this ratio forces constrained mode. */
  readonly constrainedRecentUsageAt: number;
  /** Surplus mode requires recent usage at or below this ratio. */
  readonly surplusRecentUsageAtMost: number;
  /** CPU unavailable to ordinary systems because reconcile/telemetry must finish. */
  readonly mandatoryTailReserve: number;
  /** Bucket margin required before leaving a more conservative mode. */
  readonly bucketHysteresis: number;
  /** Recent-use margin required before leaving constrained/surplus modes. */
  readonly recentUsageHysteresis: number;
}

export const DEFAULT_CPU_POLICY: Readonly<CpuPolicy> = Object.freeze({
  emergencyBucketBelow: 1_000,
  constrainedBucketBelow: 5_000,
  surplusBucketAt: 9_500,
  constrainedRecentUsageAt: 0.9,
  surplusRecentUsageAtMost: 0.65,
  mandatoryTailReserve: 5,
  bucketHysteresis: 250,
  recentUsageHysteresis: 0.05,
});

export interface CpuAdmission {
  readonly admitted: boolean;
  readonly reason: Extract<SystemSkipReason, "cpu-mode" | "tail-reserve"> | null;
  readonly budget: CpuBudget;
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }

  return value;
}

function validatePolicy(policy: CpuPolicy): void {
  finiteNonNegative(policy.emergencyBucketBelow, "emergencyBucketBelow");
  finiteNonNegative(policy.constrainedBucketBelow, "constrainedBucketBelow");
  finiteNonNegative(policy.surplusBucketAt, "surplusBucketAt");
  finiteNonNegative(policy.constrainedRecentUsageAt, "constrainedRecentUsageAt");
  finiteNonNegative(policy.surplusRecentUsageAtMost, "surplusRecentUsageAtMost");
  finiteNonNegative(policy.mandatoryTailReserve, "mandatoryTailReserve");
  finiteNonNegative(policy.bucketHysteresis, "bucketHysteresis");
  finiteNonNegative(policy.recentUsageHysteresis, "recentUsageHysteresis");

  if (policy.emergencyBucketBelow > policy.constrainedBucketBelow) {
    throw new Error("emergencyBucketBelow must not exceed constrainedBucketBelow");
  }

  if (policy.constrainedBucketBelow > policy.surplusBucketAt) {
    throw new Error("constrainedBucketBelow must not exceed surplusBucketAt");
  }
  if (
    policy.constrainedRecentUsageAt > 1 ||
    policy.surplusRecentUsageAtMost > 1 ||
    policy.recentUsageHysteresis > 1
  ) {
    throw new Error("CPU usage ratios and hysteresis must not exceed 1");
  }
}

export function captureCpuSnapshot(source: CpuSource, usedAtStart?: number): CpuSnapshot {
  return Object.freeze({
    bucket: finiteNonNegative(source.bucket, "cpu.bucket"),
    limit: finiteNonNegative(source.limit, "cpu.limit"),
    tickLimit: finiteNonNegative(source.tickLimit, "cpu.tickLimit"),
    usedAtStart: finiteNonNegative(usedAtStart ?? source.getUsed(), "tick CPU start"),
  });
}

export function deriveCpuMode(
  snapshot: CpuSnapshot,
  signals: CpuSignals,
  policy: CpuPolicy,
  previousMode: CpuMode | null = null,
): CpuMode {
  const recentUsageRatio = finiteNonNegative(signals.recentUsageRatio ?? 0, "recentUsageRatio");

  if (signals.recoveryRequired === true) {
    return "recovery";
  }

  let candidate: CpuMode;
  if (
    signals.activeThreat === true ||
    snapshot.bucket < policy.emergencyBucketBelow ||
    snapshot.tickLimit <= policy.mandatoryTailReserve
  ) {
    candidate = "emergency";
  } else if (
    snapshot.bucket < policy.constrainedBucketBelow ||
    recentUsageRatio >= policy.constrainedRecentUsageAt
  ) {
    candidate = "constrained";
  } else if (
    snapshot.bucket >= policy.surplusBucketAt &&
    recentUsageRatio <= policy.surplusRecentUsageAtMost
  ) {
    candidate = "surplus";
  } else {
    candidate = "normal";
  }

  if (
    previousMode === "emergency" &&
    candidate !== "emergency" &&
    snapshot.bucket < policy.emergencyBucketBelow + policy.bucketHysteresis
  ) {
    return "emergency";
  }
  if (
    previousMode === "constrained" &&
    (candidate === "normal" || candidate === "surplus") &&
    (snapshot.bucket < policy.constrainedBucketBelow + policy.bucketHysteresis ||
      recentUsageRatio >
        Math.max(0, policy.constrainedRecentUsageAt - policy.recentUsageHysteresis))
  ) {
    return "constrained";
  }
  if (
    previousMode === "surplus" &&
    candidate === "normal" &&
    snapshot.bucket >= policy.surplusBucketAt - policy.bucketHysteresis &&
    recentUsageRatio <= policy.surplusRecentUsageAtMost + policy.recentUsageHysteresis
  ) {
    return "surplus";
  }
  return candidate;
}

function modeAdmits(mode: CpuMode, descriptor: SystemDescriptor): boolean {
  if (descriptor.mandatoryTail || descriptor.criticality === "mandatory") {
    return true;
  }

  switch (mode) {
    case "recovery":
      return descriptor.admitInRecovery;
    case "emergency":
      return false;
    case "constrained":
      return descriptor.criticality === "operational";
    case "normal":
      return descriptor.criticality !== "maintenance";
    case "surplus":
      return true;
  }
}

export class CpuTickBudget {
  public readonly snapshot: CpuSnapshot;
  public readonly mode: CpuMode;

  public constructor(
    snapshot: CpuSnapshot,
    mode: CpuMode,
    private readonly policy: CpuPolicy,
  ) {
    this.snapshot = snapshot;
    this.mode = mode;
  }

  public admit(
    descriptor: SystemDescriptor,
    currentUsed: number,
    reservedAfterSystem = 0,
  ): CpuAdmission {
    const used = finiteNonNegative(currentUsed, "current CPU usage");
    finiteNonNegative(reservedAfterSystem, "reserved CPU after system");
    const reservedForTail = descriptor.mandatoryTail
      ? reservedAfterSystem
      : this.policy.mandatoryTailReserve;
    const hardCeiling = Math.max(0, this.snapshot.tickLimit - reservedForTail);
    const available = Math.max(0, hardCeiling - used);
    const budget: CpuBudget = Object.freeze({
      available,
      hardCeiling,
      estimate: descriptor.estimate,
      reservedForTail,
    });

    if (!modeAdmits(this.mode, descriptor)) {
      return { admitted: false, reason: "cpu-mode", budget };
    }

    if (!descriptor.mandatoryTail && descriptor.estimate > available) {
      return { admitted: false, reason: "tail-reserve", budget };
    }

    return { admitted: true, reason: null, budget };
  }
}

export class CpuScheduler {
  public readonly policy: Readonly<CpuPolicy>;
  private previousMode: CpuMode | null;

  public constructor(overrides: Partial<CpuPolicy> = {}, initialMode: CpuMode | null = null) {
    const policy: CpuPolicy = { ...DEFAULT_CPU_POLICY, ...overrides };
    validatePolicy(policy);
    this.policy = Object.freeze(policy);
    this.previousMode = initialMode;
  }

  public startTick(
    source: CpuSource,
    signals: CpuSignals = {},
    usedAtStart?: number,
  ): CpuTickBudget {
    const snapshot = captureCpuSnapshot(source, usedAtStart);
    const mode = deriveCpuMode(snapshot, signals, this.policy, this.previousMode);
    this.previousMode = mode;
    return new CpuTickBudget(snapshot, mode, this.policy);
  }

  public getCurrentMode(): CpuMode | null {
    return this.previousMode;
  }
}
