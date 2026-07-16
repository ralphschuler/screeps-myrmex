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
