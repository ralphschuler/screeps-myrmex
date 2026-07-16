import { opaqueId, safeCode } from "../security";

export interface ReporterEvent {
  readonly fingerprint: string;
  readonly kind: "first" | "reminder" | "resolved";
  readonly count: number;
  readonly reasonCode: string;
}

export interface ReporterSignal {
  readonly kind: string;
  readonly identity: string;
  readonly reasonCode: string;
}

export interface ReporterSignalBatch {
  readonly candidates: readonly {
    readonly fingerprint: string;
    readonly reasonCode: string;
  }[];
  readonly fingerprints: ReadonlySet<string>;
  /** FNV state after each canonical candidate prefix; index zero is the empty prefix. */
  readonly overflowPrefixHashes: readonly number[];
}

export interface ReporterStatePolicy {
  /** Maximum already-bounded aggregation inputs inspected by this reducer. */
  readonly maximumInputSignals: number;
  readonly maximumFingerprints: number;
  /** Effective durable capacity after the enclosing telemetry-owner byte budget is applied. */
  readonly maximumRetainedFingerprints: number;
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
    row.categories.length > 3 ||
    (row.level !== "debug" && row.level !== "trace") ||
    typeof row.expiresAtTick !== "number" ||
    !Number.isSafeInteger(row.expiresAtTick) ||
    row.expiresAtTick <= tick ||
    row.expiresAtTick > saturatingAdd(tick, maximumDurationTicks)
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
  const parsed = readRecovery(owner, input.tick, policy.maximumReminderDelayTicks);
  if (!input.active) return { owner: null, event: null, status: null };
  const tick = safeNonnegativeInteger(input.tick);
  const delivered = safeNonnegativeInteger(input.delivered);
  const harvested = safeNonnegativeInteger(input.harvested);
  const spawnDemand = safeNonnegativeInteger(input.spawnDemand);
  const spawnScheduled = safeNonnegativeInteger(input.spawnScheduled);
  const unmet = safeNonnegativeInteger(input.unmet);
  const blockerRef =
    input.blockerRef === null ? null : opaqueId("recovery-blocker", input.blockerRef);
  const blockerReasonCode = safeCode(input.blockerReasonCode);
  const signature = [
    safeCode(input.status),
    spawnDemand,
    spawnScheduled,
    harvested,
    delivered,
    unmet,
    blockerRef ?? "none",
    blockerReasonCode,
  ].join("|");
  const progressed =
    parsed === null ||
    parsed.signature !== signature ||
    spawnScheduled > 0 ||
    harvested > 0 ||
    delivered > 0;
  const lastProgressTick = progressed ? tick : parsed.lastProgressTick;
  const priorReminderAtTick = progressed ? null : parsed.reminderAtTick;
  const priorReminderCount = progressed ? 0 : parsed.reminderCount;
  const priorStuckReportedAtTick = progressed ? null : parsed.stuckReportedAtTick;
  const stuck =
    !progressed &&
    tick >= saturatingAdd(lastProgressTick, safeNonnegativeInteger(policy.stuckWindowTicks));
  const due = priorReminderAtTick !== null && tick >= priorReminderAtTick;
  const shouldReport = stuck && (priorStuckReportedAtTick === null || due);
  const reminderAtTick = shouldReport
    ? saturatingAdd(tick, reminderDelay(policy, priorReminderCount))
    : priorReminderAtTick;
  const reminderCount = shouldReport ? saturatingIncrement(priorReminderCount) : priorReminderCount;
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
      stuckReportedAtTick: shouldReport ? tick : priorStuckReportedAtTick,
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
  signals: readonly ReporterSignal[],
  policy: ReporterStatePolicy,
): { readonly owner: unknown; readonly events: readonly ReporterEvent[] } {
  return advancePreparedReporterState(
    owner,
    tick,
    prepareReporterSignals(signals, policy.maximumInputSignals),
    policy,
  );
}

/** Sanitizes, deduplicates, and sorts a bounded source batch exactly once per tick. */
export function prepareReporterSignals(
  signals: readonly ReporterSignal[],
  maximumInputSignals: number,
): ReporterSignalBatch | null {
  const boundedSignals = readBoundedSignals(signals, safeNonnegativeInteger(maximumInputSignals));
  if (boundedSignals === null) return null;
  const deduplicated = new Map<string, { fingerprint: string; reasonCode: string }>();
  for (const signal of boundedSignals) {
    const candidate = {
      fingerprint: opaqueId(signal.kind, signal.identity),
      reasonCode: safeCode(signal.reasonCode),
    };
    const prior = deduplicated.get(candidate.fingerprint);
    if (prior === undefined || candidate.reasonCode > prior.reasonCode) {
      deduplicated.set(candidate.fingerprint, candidate);
    }
  }
  const candidates = [...deduplicated.values()].sort(
    (left, right) =>
      compareStrings(left.fingerprint, right.fingerprint) ||
      compareStrings(left.reasonCode, right.reasonCode),
  );
  const overflowPrefixHashes = [0x811c9dc5];
  let prefixHash = 0x811c9dc5;
  for (const candidate of candidates) {
    prefixHash = updateOverflowHash(prefixHash, candidate.fingerprint);
    prefixHash = updateOverflowHash(prefixHash, ":");
    prefixHash = updateOverflowHash(prefixHash, candidate.reasonCode);
    prefixHash = updateOverflowHash(prefixHash, "|");
    overflowPrefixHashes.push(prefixHash);
  }
  return {
    candidates,
    fingerprints: new Set(candidates.map(({ fingerprint }) => fingerprint)),
    overflowPrefixHashes,
  };
}

/** Reuses one prepared source batch while the enclosing owner resolves its durable byte capacity. */
export function advancePreparedReporterState(
  owner: unknown,
  tick: number,
  signals: ReporterSignalBatch | null,
  policy: Omit<ReporterStatePolicy, "maximumInputSignals">,
): { readonly owner: unknown; readonly events: readonly ReporterEvent[] } {
  const maximumFingerprints = safeNonnegativeInteger(policy.maximumFingerprints);
  const maximumRetainedFingerprints = Math.min(
    maximumFingerprints,
    safeNonnegativeInteger(policy.maximumRetainedFingerprints),
  );
  const currentTick = safeNonnegativeInteger(tick);
  const previous = read(
    owner,
    maximumFingerprints,
    currentTick,
    safeNonnegativeInteger(policy.maximumReminderDelayTicks),
  );
  if (signals === null) {
    return { owner: reporterOwner(previous, maximumRetainedFingerprints), events: [] };
  }
  const current = boundCurrentSignals(signals, maximumRetainedFingerprints);
  const next: Entry[] = [];
  const events: ReporterEvent[] = [];
  for (const signal of current) {
    const prior = previous.get(signal.fingerprint);
    if (prior === undefined) {
      next.push({
        fingerprint: signal.fingerprint,
        count: 1,
        lastTick: currentTick,
        nextReminderTick: saturatingAdd(
          currentTick,
          safeNonnegativeInteger(policy.initialReminderDelayTicks),
        ),
        reasonCode: signal.reasonCode,
      });
      events.push({
        fingerprint: signal.fingerprint,
        kind: "first",
        count: 1,
        reasonCode: signal.reasonCode,
      });
    } else if (currentTick >= prior.nextReminderTick) {
      const count = saturatingIncrement(prior.count);
      next.push({
        fingerprint: prior.fingerprint,
        count,
        lastTick: currentTick,
        nextReminderTick: saturatingAdd(currentTick, reminderDelay(policy, count - 1)),
        reasonCode: signal.reasonCode,
      });
      events.push({
        fingerprint: prior.fingerprint,
        kind: "reminder",
        count,
        reasonCode: signal.reasonCode,
      });
    } else next.push({ ...prior, lastTick: currentTick, reasonCode: signal.reasonCode });
  }
  const retainedCurrentFingerprints = new Set(current.map(({ fingerprint }) => fingerprint));
  for (const prior of previous.values())
    if (
      !signals.fingerprints.has(prior.fingerprint) &&
      !retainedCurrentFingerprints.has(prior.fingerprint)
    )
      events.push({
        fingerprint: prior.fingerprint,
        kind: "resolved",
        count: prior.count,
        reasonCode: prior.reasonCode,
      });
  const ordered = next.sort(
    (a, b) => a.lastTick - b.lastTick || a.fingerprint.localeCompare(b.fingerprint),
  );
  const entries =
    maximumRetainedFingerprints === 0 ? [] : ordered.slice(-maximumRetainedFingerprints);
  const retained = new Set(entries.map(({ fingerprint }) => fingerprint));
  return {
    owner: { schemaVersion: 1, entries },
    events: events.filter(
      ({ fingerprint, kind }) => kind === "resolved" || retained.has(fingerprint),
    ),
  };
}

function boundCurrentSignals(
  batch: ReporterSignalBatch,
  maximumFingerprints: number,
): readonly { readonly fingerprint: string; readonly reasonCode: string }[] {
  const current = batch.candidates;
  if (maximumFingerprints === 0) return [];
  if (current.length <= maximumFingerprints) return current;
  const retainedCount = maximumFingerprints - 1;
  const retained = retainedCount === 0 ? [] : current.slice(-retainedCount);
  const omittedCount = current.length - retainedCount;
  const overflow = {
    fingerprint: overflowFingerprint(batch.overflowPrefixHashes[omittedCount] ?? 0x811c9dc5),
    reasonCode: "reporter-cardinality-overflow",
  };
  return [...retained, overflow].sort((left, right) =>
    compareStrings(left.fingerprint, right.fingerprint),
  );
}

function overflowFingerprint(hash: number): string {
  return `reporter-overflow:${hash.toString(16).padStart(8, "0")}`;
}

function updateOverflowHash(initial: number, value: string): number {
  let hash = initial;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function reporterOwner(previous: ReadonlyMap<string, Entry>, maximumFingerprints: number): unknown {
  const ordered = [...previous.values()].sort(
    (left, right) =>
      left.lastTick - right.lastTick || compareStrings(left.fingerprint, right.fingerprint),
  );
  const entries = maximumFingerprints === 0 ? [] : ordered.slice(-maximumFingerprints);
  return { schemaVersion: 1, entries };
}

function readBoundedSignals(
  value: readonly ReporterSignal[],
  maximumLength: number,
): readonly ReporterSignal[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      length === undefined ||
      !("value" in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > maximumLength
    )
      return null;
    const output: ReporterSignal[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (entry === undefined || !("value" in entry)) return null;
      output.push(entry.value as ReporterSignal);
    }
    return output;
  } catch {
    return null;
  }
}

function read(
  value: unknown,
  maximumFingerprints: number,
  currentTick: number,
  maximumReminderDelayTicks: number,
): Map<string, Entry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1) return new Map();
  const entries = root.entries;
  if (!Array.isArray(entries) || entries.length > maximumFingerprints) return new Map();
  const parsed = new Map<string, Entry>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return new Map();
    const row = entry as Record<string, unknown>;
    if (
      !isOpaqueReference(row.fingerprint) ||
      typeof row.count !== "number" ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1 ||
      typeof row.lastTick !== "number" ||
      !Number.isSafeInteger(row.lastTick) ||
      row.lastTick < 0 ||
      row.lastTick > currentTick ||
      typeof row.nextReminderTick !== "number" ||
      !Number.isSafeInteger(row.nextReminderTick) ||
      row.nextReminderTick < 0 ||
      row.nextReminderTick < row.lastTick ||
      row.nextReminderTick > saturatingAdd(currentTick, maximumReminderDelayTicks) ||
      typeof row.reasonCode !== "string" ||
      safeCode(row.reasonCode) !== row.reasonCode ||
      parsed.has(row.fingerprint)
    )
      return new Map();
    parsed.set(row.fingerprint, {
      fingerprint: row.fingerprint,
      count: row.count,
      lastTick: row.lastTick,
      nextReminderTick: row.nextReminderTick,
      reasonCode: row.reasonCode,
    });
  }
  return parsed;
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

function readRecovery(
  value: unknown,
  currentTick: number,
  maximumReminderDelayTicks: number,
): RecoveryOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.signature === "string" &&
    row.signature.length <= 256 &&
    typeof row.lastProgressTick === "number" &&
    Number.isSafeInteger(row.lastProgressTick) &&
    row.lastProgressTick >= 0 &&
    row.lastProgressTick <= safeNonnegativeInteger(currentTick) &&
    typeof row.reminderCount === "number" &&
    Number.isSafeInteger(row.reminderCount) &&
    row.reminderCount >= 0 &&
    isOptionalTick(row.reminderAtTick) &&
    (row.reminderAtTick === null ||
      row.reminderAtTick <=
        saturatingAdd(currentTick, safeNonnegativeInteger(maximumReminderDelayTicks))) &&
    isOptionalTick(row.stuckReportedAtTick) &&
    (row.stuckReportedAtTick === null || row.stuckReportedAtTick <= currentTick) &&
    (isOpaqueReference(row.blockerRef) || row.blockerRef === null) &&
    typeof row.blockerReasonCode === "string" &&
    safeCode(row.blockerReasonCode) === row.blockerReasonCode
    ? {
        signature: row.signature,
        lastProgressTick: row.lastProgressTick,
        reminderCount: row.reminderCount,
        reminderAtTick: row.reminderAtTick,
        stuckReportedAtTick: row.stuckReportedAtTick,
        blockerRef: row.blockerRef,
        blockerReasonCode: row.blockerReasonCode,
      }
    : null;
}

function isOptionalTick(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isOpaqueReference(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{8}$/.test(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reminderDelay(
  policy: Pick<ReporterStatePolicy, "initialReminderDelayTicks" | "maximumReminderDelayTicks">,
  exponent: number,
): number {
  const maximum = safeNonnegativeInteger(policy.maximumReminderDelayTicks);
  let delay = Math.min(maximum, safeNonnegativeInteger(policy.initialReminderDelayTicks));
  const doublings = Math.min(20, safeNonnegativeInteger(exponent));
  for (let index = 0; index < doublings && delay < maximum; index += 1) {
    delay = Math.min(maximum, saturatingAdd(delay, delay));
  }
  return delay;
}

function safeNonnegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function saturatingAdd(left: number, right: number): number {
  const safeLeft = safeNonnegativeInteger(left);
  const safeRight = safeNonnegativeInteger(right);
  return safeLeft > Number.MAX_SAFE_INTEGER - safeRight
    ? Number.MAX_SAFE_INTEGER
    : safeLeft + safeRight;
}

function saturatingIncrement(value: number): number {
  const safeValue = safeNonnegativeInteger(value);
  return safeValue >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : safeValue + 1;
}
