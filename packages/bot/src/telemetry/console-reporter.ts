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
    const candidates = [line, ...diagnosticLines(status)];
    const bounded = boundAll(candidates, policy.maximumLinesPerTick, policy.maximumBytesPerTick);
    if (bounded.length === 0) return [];
    try {
      for (const entry of bounded) sink.log(entry);
      return bounded;
    } catch {
      return [];
    }
  }
}

function diagnosticLines(status: ReporterStatus): readonly string[] {
  const diagnostic = status.diagnostic;
  if (diagnostic === null) return [];
  const prefix = `[MYRMEX][${diagnostic.level.toUpperCase()}][${status.runtime.shardRef}][t=${text(status.tick)}] diagnostic`;
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
