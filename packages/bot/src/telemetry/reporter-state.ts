import { opaqueId, safeCode } from "../security";

export interface ReporterEvent {
  readonly fingerprint: string;
  readonly kind: "first" | "reminder" | "resolved";
  readonly count: number;
  readonly reasonCode: string;
}

export interface ReporterStatePolicy {
  readonly maximumFingerprints: number;
  readonly initialReminderDelayTicks: number;
  readonly maximumReminderDelayTicks: number;
}

export type DiagnosticCategory = "recovery" | "blockers" | "faults";
export type DiagnosticLevel = "debug" | "trace";

export interface DiagnosticWindow {
  readonly level: DiagnosticLevel;
  readonly categories: readonly DiagnosticCategory[];
  readonly expiresAtTick: number;
}

export interface RecoveryProgressInput {
  readonly active: boolean;
  readonly blockerRef: string | null;
  readonly blockerReasonCode: string;
  readonly delivered: number;
  readonly harvested: number;
  readonly spawnDemand: number;
  readonly spawnScheduled: number;
  readonly status: string;
  readonly tick: number;
  readonly unmet: number;
}

export interface RecoveryProgressPolicy {
  readonly initialReminderDelayTicks: number;
  readonly maximumReminderDelayTicks: number;
  readonly stuckWindowTicks: number;
}

export interface RecoveryProgressStatus {
  readonly blockerReasonCode: string;
  readonly blockerRef: string | null;
  readonly lastProgressTick: number;
  readonly reminderAtTick: number | null;
  readonly stuck: boolean;
}

export interface StuckRecoveryEvent extends RecoveryProgressStatus {
  readonly owner: "colony";
  readonly reasonCode: "recovery-progress-unchanged";
}

/** Accepts only fixed observer categories; exact expiry is inactive at `expiresAtTick`. */
export function resolveDiagnosticWindow(
  value: unknown,
  tick: number,
  maximumDurationTicks: number,
): DiagnosticWindow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !Array.isArray(row.categories) ||
    (row.level !== "debug" && row.level !== "trace") ||
    typeof row.expiresAtTick !== "number" ||
    !Number.isSafeInteger(row.expiresAtTick) ||
    row.expiresAtTick <= tick ||
    row.expiresAtTick > tick + maximumDurationTicks
  )
    return null;
  const allowed = new Set<DiagnosticCategory>(["recovery", "blockers", "faults"]);
  const categories = row.categories.filter(
    (category): category is DiagnosticCategory =>
      typeof category === "string" && allowed.has(category as DiagnosticCategory),
  );
  if (
    categories.length !== row.categories.length ||
    categories.length === 0 ||
    new Set(categories).size !== categories.length
  )
    return null;
  return { level: row.level, categories: categories.sort(), expiresAtTick: row.expiresAtTick };
}

/** Tracks only safe, aggregate recovery evidence; it cannot issue retries or commands. */
export function advanceRecoveryProgress(
  owner: unknown,
  input: RecoveryProgressInput,
  policy: RecoveryProgressPolicy,
): {
  readonly owner: unknown;
  readonly event: StuckRecoveryEvent | null;
  readonly status: RecoveryProgressStatus | null;
} {
  const parsed = readRecovery(owner);
  if (!input.active) return { owner: null, event: null, status: null };
  const blockerRef =
    input.blockerRef === null ? null : opaqueId("recovery-blocker", input.blockerRef);
  const blockerReasonCode = safeCode(input.blockerReasonCode);
  const signature = [
    safeCode(input.status),
    input.spawnDemand,
    input.spawnScheduled,
    input.harvested,
    input.delivered,
    input.unmet,
    blockerRef ?? "none",
    blockerReasonCode,
  ].join("|");
  const progressed =
    parsed === null ||
    parsed.signature !== signature ||
    input.spawnScheduled > 0 ||
    input.harvested > 0 ||
    input.delivered > 0;
  const lastProgressTick = progressed ? input.tick : parsed.lastProgressTick;
  const priorReminderAtTick = progressed ? null : parsed.reminderAtTick;
  const priorReminderCount = progressed ? 0 : parsed.reminderCount;
  const priorStuckReportedAtTick = progressed ? null : parsed.stuckReportedAtTick;
  const stuck = !progressed && input.tick - lastProgressTick >= policy.stuckWindowTicks;
  const due = priorReminderAtTick !== null && input.tick >= priorReminderAtTick;
  const shouldReport = stuck && (priorStuckReportedAtTick === null || due);
  const reminderAtTick = shouldReport
    ? input.tick +
      Math.min(
        policy.maximumReminderDelayTicks,
        policy.initialReminderDelayTicks * 2 ** Math.min(20, priorReminderCount),
      )
    : priorReminderAtTick;
  const reminderCount = shouldReport ? priorReminderCount + 1 : priorReminderCount;
  const status: RecoveryProgressStatus = {
    blockerRef,
    blockerReasonCode,
    lastProgressTick,
    reminderAtTick,
    stuck,
  };
  return {
    owner: {
      signature,
      lastProgressTick,
      reminderAtTick,
      reminderCount,
      stuckReportedAtTick: shouldReport ? input.tick : priorStuckReportedAtTick,
      blockerRef,
      blockerReasonCode,
    },
    event: shouldReport
      ? { ...status, owner: "colony", reasonCode: "recovery-progress-unchanged" }
      : null,
    status,
  };
}

interface Entry {
  readonly fingerprint: string;
  readonly count: number;
  readonly lastTick: number;
  readonly nextReminderTick: number;
  readonly reasonCode: string;
}

/** Pure bounded reporter metadata transition; callers persist it only through TelemetryService. */
export function advanceReporterState(
  owner: unknown,
  tick: number,
  signals: readonly {
    readonly kind: string;
    readonly identity: string;
    readonly reasonCode: string;
  }[],
  policy: ReporterStatePolicy,
): { readonly owner: unknown; readonly events: readonly ReporterEvent[] } {
  const previous = read(owner);
  const current = signals
    .map((signal) => ({
      fingerprint: opaqueId(signal.kind, signal.identity),
      reasonCode: safeCode(signal.reasonCode),
    }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const next: Entry[] = [];
  const events: ReporterEvent[] = [];
  for (const signal of current) {
    const prior = previous.get(signal.fingerprint);
    if (prior === undefined) {
      next.push({
        fingerprint: signal.fingerprint,
        count: 1,
        lastTick: tick,
        nextReminderTick: tick + policy.initialReminderDelayTicks,
        reasonCode: signal.reasonCode,
      });
      events.push({
        fingerprint: signal.fingerprint,
        kind: "first",
        count: 1,
        reasonCode: signal.reasonCode,
      });
    } else if (tick >= prior.nextReminderTick) {
      const count = prior.count + 1;
      next.push({
        fingerprint: prior.fingerprint,
        count,
        lastTick: tick,
        nextReminderTick:
          tick +
          Math.min(
            policy.maximumReminderDelayTicks,
            policy.initialReminderDelayTicks * 2 ** Math.min(20, count - 1),
          ),
        reasonCode: signal.reasonCode,
      });
      events.push({
        fingerprint: prior.fingerprint,
        kind: "reminder",
        count,
        reasonCode: signal.reasonCode,
      });
    } else next.push({ ...prior, lastTick: tick, reasonCode: signal.reasonCode });
  }
  for (const prior of previous.values())
    if (!current.some(({ fingerprint }) => fingerprint === prior.fingerprint))
      events.push({
        fingerprint: prior.fingerprint,
        kind: "resolved",
        count: prior.count,
        reasonCode: prior.reasonCode,
      });
  const entries = next
    .sort((a, b) => a.lastTick - b.lastTick || a.fingerprint.localeCompare(b.fingerprint))
    .slice(-policy.maximumFingerprints);
  return { owner: { schemaVersion: 1, entries }, events };
}

function read(value: unknown): Map<string, Entry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return new Map();
  return new Map(
    entries
      .flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const row = entry as Record<string, unknown>;
        return typeof row.fingerprint === "string" &&
          typeof row.count === "number" &&
          typeof row.lastTick === "number" &&
          typeof row.nextReminderTick === "number" &&
          typeof row.reasonCode === "string"
          ? [
              {
                fingerprint: row.fingerprint.slice(0, 96),
                count: Math.max(1, row.count),
                lastTick: Math.max(0, row.lastTick),
                nextReminderTick: Math.max(0, row.nextReminderTick),
                reasonCode: safeCode(row.reasonCode),
              },
            ]
          : [];
      })
      .map((entry) => [entry.fingerprint, entry]),
  );
}

interface RecoveryOwner {
  readonly blockerReasonCode: string;
  readonly blockerRef: string | null;
  readonly lastProgressTick: number;
  readonly reminderAtTick: number | null;
  readonly reminderCount: number;
  readonly signature: string;
  readonly stuckReportedAtTick: number | null;
}

function readRecovery(value: unknown): RecoveryOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.signature === "string" &&
    typeof row.lastProgressTick === "number" &&
    Number.isSafeInteger(row.lastProgressTick) &&
    typeof row.reminderCount === "number" &&
    Number.isSafeInteger(row.reminderCount) &&
    (typeof row.reminderAtTick === "number" || row.reminderAtTick === null) &&
    (typeof row.stuckReportedAtTick === "number" || row.stuckReportedAtTick === null) &&
    (typeof row.blockerRef === "string" || row.blockerRef === null) &&
    typeof row.blockerReasonCode === "string"
    ? {
        signature: row.signature.slice(0, 256),
        lastProgressTick: Math.max(0, row.lastProgressTick),
        reminderCount: Math.max(0, row.reminderCount),
        reminderAtTick:
          typeof row.reminderAtTick === "number" ? Math.max(0, row.reminderAtTick) : null,
        stuckReportedAtTick:
          typeof row.stuckReportedAtTick === "number" ? Math.max(0, row.stuckReportedAtTick) : null,
        blockerRef: typeof row.blockerRef === "string" ? row.blockerRef.slice(0, 96) : null,
        blockerReasonCode: safeCode(row.blockerReasonCode),
      }
    : null;
}
