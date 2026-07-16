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
    if (policy.baseLevel === "silent") return [];
    const recovery = status.runtime.memoryStatus === "recovery";
    if (!recovery && status.tick % policy.heartbeatIntervalTicks !== 0) return [];
    const level = recovery ? "WARN" : "INFO";
    const line =
      `[MYRMEX][${level}][${status.runtime.shardRef}][t=${text(status.tick)}] ` +
      `mode=${status.runtime.cpuMode} cpu=${text(status.runtime.cpuUsedMilli)}/${text(status.runtime.cpuLimit * 1000)} ` +
      `bucket=${text(status.runtime.cpuBucket)} observer=${status.observer.status} ` +
      `colony=${status.colony.status} objectives=${text(status.colony.objectives)} recovery=${text(status.recovery.required)} ` +
      `spawnDemand=${text(status.recovery.spawnDemand)} harvested=${text(status.recovery.harvested)} delivered=${text(status.recovery.delivered)} unmet=${text(status.recovery.unmet)} ` +
      `blockers=${text(status.blockers.length)} faults=${text(status.faults.length)}`;
    const bounded = bound(line, policy.maximumBytesPerTick);
    if (bounded === null || policy.maximumLinesPerTick < 1) return [];
    try {
      sink.log(bounded);
      return [bounded];
    } catch {
      return [];
    }
  }
}

function bound(line: string, maximumBytes: number): string | null {
  return utf8ByteLength(line) <= maximumBytes ? line : null;
}

function text(value: number | boolean): string {
  return String(value);
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
