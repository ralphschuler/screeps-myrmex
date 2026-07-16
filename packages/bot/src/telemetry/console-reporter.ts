import type { ReporterStatus } from "./reporter-status";

declare const console: ConsoleSink;

export interface ConsoleSink {
  log(line: string): void;
}

export interface ConsoleReporterPolicy {
  readonly baseLevel: string;
  readonly heartbeatIntervalTicks: number;
  readonly maximumLinesPerTick: number;
  readonly maximumBytesPerTick: number;
}

/** The sole production console adapter. It accepts only the redacted ReporterStatus contract. */
export class ConsoleReporter {
  public report(
    status: ReporterStatus,
    policy: ConsoleReporterPolicy,
    sink: ConsoleSink = console,
  ): readonly string[] {
    try {
      if (policy.baseLevel === "silent") return [];
      const recovery = status.recovery.required;
      const heartbeat = recovery || status.tick % policy.heartbeatIntervalTicks === 0;
      const transitions = transitionLines(status);
      if (!heartbeat && transitions.length === 0) return [];
      const candidates = [
        ...transitions,
        ...(heartbeat ? [heartbeatLine(status, recovery), ...diagnosticLines(status)] : []),
      ];
      const bounded = boundAll(candidates, policy.maximumLinesPerTick, policy.maximumBytesPerTick);
      if (bounded.length === 0) return [];
      for (const entry of bounded) sink.log(entry);
      return bounded;
    } catch {
      return [];
    }
  }
}

function heartbeatLine(status: ReporterStatus, recovery: boolean): string {
  const level = recovery ? "WARN" : "INFO";
  return (
    `[MYRMEX][${level}][${reference(status.runtime.shardRef)}][t=${text(status.tick)}] ` +
    `mode=${code(status.runtime.cpuMode)} cpu=${text(status.runtime.cpuUsedMilli)}/${text(status.runtime.cpuLimit * 1000)} ` +
    `bucket=${text(status.runtime.cpuBucket)} observer=${code(status.observer.status)} ` +
    `colony=${code(status.colony.status)} objectives=${text(status.colony.objectives)} recovery=${text(status.recovery.required)} ` +
    `spawnDemand=${text(status.recovery.spawnDemand)} harvested=${text(status.recovery.harvested)} delivered=${text(status.recovery.delivered)} unmet=${text(status.recovery.unmet)} ` +
    `blockers=${text(status.blockers.length)} faults=${text(status.faults.length)}`
  );
}

function transitionLines(status: ReporterStatus): readonly string[] {
  const value: unknown = status.transitions;
  if (!Array.isArray(value)) return [];
  const prefix = `[MYRMEX][`;
  return value.flatMap((transition): string[] => {
    if (!isRecord(transition)) return [];
    if (
      transition.category === "signal" &&
      exactKeys(transition, ["category", "kind", "fingerprint", "count", "reasonCode"]) &&
      (transition.kind === "first" ||
        transition.kind === "reminder" ||
        transition.kind === "resolved") &&
      isReference(transition.fingerprint) &&
      isPositiveInteger(transition.count) &&
      isCode(transition.reasonCode)
    ) {
      const level = transition.kind === "resolved" ? "INFO" : "WARN";
      return [
        `${prefix}${level}][${reference(status.runtime.shardRef)}][t=${text(status.tick)}] reporter signal kind=${transition.kind} fingerprint=${transition.fingerprint} count=${text(transition.count)} reason=${transition.reasonCode}`,
      ];
    }
    if (
      transition.category === "recovery" &&
      exactKeys(transition, [
        "category",
        "kind",
        "owner",
        "blockerReasonCode",
        "blockerRef",
        "lastProgressTick",
        "reminderAtTick",
        "reasonCode",
      ]) &&
      transition.kind === "stuck" &&
      transition.owner === "colony" &&
      isCode(transition.blockerReasonCode) &&
      (transition.blockerRef === null || isReference(transition.blockerRef)) &&
      isNonNegativeInteger(transition.lastProgressTick) &&
      (transition.reminderAtTick === null || isNonNegativeInteger(transition.reminderAtTick)) &&
      transition.reasonCode === "recovery-progress-unchanged"
    ) {
      return [
        `${prefix}WARN][${reference(status.runtime.shardRef)}][t=${text(status.tick)}] reporter recovery kind=stuck owner=colony blocker=${transition.blockerRef ?? "none"} blockerReason=${transition.blockerReasonCode} lastProgress=${text(transition.lastProgressTick)} reminderAt=${text(transition.reminderAtTick ?? 0)} reason=recovery-progress-unchanged`,
      ];
    }
    return [];
  });
}

function diagnosticLines(status: ReporterStatus): readonly string[] {
  const diagnostic = status.diagnostic;
  if (diagnostic === null) return [];
  const level = diagnostic.level === "trace" ? "TRACE" : "DEBUG";
  const prefix = `[MYRMEX][${level}][${reference(status.runtime.shardRef)}][t=${text(status.tick)}] diagnostic`;
  const lines: string[] = [];
  for (const category of diagnostic.categories) {
    switch (category) {
      case "recovery": {
        const stuck = status.recovery.stuck;
        lines.push(
          `${prefix} recovery required=${text(status.recovery.required)} stuck=${text(stuck?.active ?? false)} lastProgress=${text(stuck?.lastProgressTick ?? 0)} reminderAt=${text(stuck?.reminderAtTick ?? 0)}`,
        );
        break;
      }
      case "blockers":
        lines.push(`${prefix} blockers count=${text(status.blockers.length)}`);
        break;
      case "faults":
        lines.push(`${prefix} faults count=${text(status.faults.length)}`);
        break;
    }
  }
  return lines;
}

function boundAll(
  lines: readonly string[],
  maximumLines: number,
  maximumBytes: number,
): readonly string[] {
  const bounded: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = utf8ByteLength(line);
    if (bounded.length >= maximumLines || bytes + lineBytes > maximumBytes) break;
    bounded.push(line);
    bytes += lineBytes;
  }
  return bounded;
}

function text(value: number | boolean): string {
  return String(value);
}

function code(value: unknown): string {
  return isCode(value) ? value : "invalid-code";
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function reference(value: unknown): string {
  return isReference(value) ? value : "unknown:00000000";
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{8}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      index += 1;
      bytes += 4;
    } else bytes += 3;
  }
  return bytes;
}
