import type { ReporterStatus } from "./reporter-status";

declare const console: ConsoleSink;

const MAXIMUM_RENDERABLE_TRANSITIONS = 64;
const MAXIMUM_RENDERABLE_DIAGNOSTIC_CATEGORIES = 3;
const MAXIMUM_TRANSITION_COUNT = 1_000_000;

export interface ConsoleSink {
  log(line: string): void;
}

export interface ConsoleReporterPolicy {
  readonly baseLevel: string;
  readonly heartbeatIntervalTicks: number;
  readonly maximumLinesPerTick: number;
  readonly maximumBytesPerTick: number;
  readonly maximumImmediateEventsPerTick: number;
}

/** The sole production console adapter. It accepts only the redacted ReporterStatus contract. */
export class ConsoleReporter {
  public report(
    status: ReporterStatus,
    policy: ConsoleReporterPolicy,
    sink: ConsoleSink = console,
  ): readonly string[] {
    try {
      const boundedPolicy = readPolicy(policy);
      if (boundedPolicy === null || boundedPolicy.baseLevel === "silent") return [];
      if (boundedPolicy.maximumLinesPerTick === 0 || boundedPolicy.maximumBytesPerTick === 0)
        return [];
      if (!isNonNegativeInteger(status.tick)) return [];
      const recovery = strictBoolean(status.recovery.required);
      const heartbeat = recovery || status.tick % boundedPolicy.heartbeatIntervalTicks === 0;
      const shardRef = reference(status.runtime.shardRef);
      const transitions = transitionLines(
        status.transitions,
        boundedPolicy.maximumImmediateEventsPerTick,
        shardRef,
        status.tick,
      );
      if (!heartbeat && transitions.length === 0) return [];
      const candidates = [
        ...transitions,
        ...(heartbeat
          ? [
              heartbeatLine(status, recovery, shardRef, status.tick),
              ...diagnosticLines(status, shardRef, status.tick),
            ]
          : []),
      ];
      const bounded = boundAll(
        candidates,
        boundedPolicy.maximumLinesPerTick,
        boundedPolicy.maximumBytesPerTick,
      );
      if (bounded.length === 0) return [];
      for (const entry of bounded) sink.log(entry);
      return bounded;
    } catch {
      return [];
    }
  }
}

function heartbeatLine(
  status: ReporterStatus,
  recovery: boolean,
  shardRef: string,
  tick: number,
): string {
  const level = recovery ? "WARN" : "INFO";
  return (
    `[MYRMEX][${level}][${shardRef}][t=${text(tick)}] ` +
    `mode=${code(status.runtime.cpuMode)} cpu=${text(status.runtime.cpuUsedMilli)}/${text(scaledMilli(status.runtime.cpuLimit))} ` +
    `bucket=${text(status.runtime.cpuBucket)} observer=${code(status.observer.status)} ` +
    `colony=${code(status.colony.status)} objectives=${text(status.colony.objectives)} recovery=${text(status.recovery.required)} ` +
    `spawnDemand=${text(status.recovery.spawnDemand)} harvested=${text(status.recovery.harvested)} delivered=${text(status.recovery.delivered)} unmet=${text(status.recovery.unmet)} ` +
    `blockers=${text(arrayLength(status.blockers))} faults=${text(arrayLength(status.faults))}`
  );
}

function transitionLines(
  value: unknown,
  maximumTransitions: number,
  shardRef: string,
  tick: number,
): readonly string[] {
  const transitions = readBoundedDataArray(value, maximumTransitions);
  if (transitions === null) return [];
  const prefix = `[MYRMEX][`;
  const lines: string[] = [];
  for (const value of transitions) {
    const transition = readDataRecord(value, [
      "category",
      "kind",
      "fingerprint",
      "count",
      "reasonCode",
    ]);
    if (
      transition !== null &&
      transition.category === "signal" &&
      (transition.kind === "first" ||
        transition.kind === "reminder" ||
        transition.kind === "resolved") &&
      isReference(transition.fingerprint) &&
      isPositiveInteger(transition.count) &&
      transition.count <= MAXIMUM_TRANSITION_COUNT &&
      isCode(transition.reasonCode)
    ) {
      const level = transition.kind === "resolved" ? "INFO" : "WARN";
      lines.push(
        `${prefix}${level}][${shardRef}][t=${text(tick)}] reporter signal kind=${transition.kind} fingerprint=${transition.fingerprint} count=${text(transition.count)} reason=${transition.reasonCode}`,
      );
      continue;
    }
    const recovery = readDataRecord(value, [
      "category",
      "kind",
      "owner",
      "blockerReasonCode",
      "blockerRef",
      "lastProgressTick",
      "reminderAtTick",
      "reasonCode",
    ]);
    if (
      recovery !== null &&
      recovery.category === "recovery" &&
      recovery.kind === "stuck" &&
      recovery.owner === "colony" &&
      isCode(recovery.blockerReasonCode) &&
      (recovery.blockerRef === null || isReference(recovery.blockerRef)) &&
      isNonNegativeInteger(recovery.lastProgressTick) &&
      (recovery.reminderAtTick === null || isNonNegativeInteger(recovery.reminderAtTick)) &&
      recovery.reasonCode === "recovery-progress-unchanged"
    ) {
      lines.push(
        `${prefix}WARN][${shardRef}][t=${text(tick)}] reporter recovery kind=stuck owner=colony blocker=${recovery.blockerRef ?? "none"} blockerReason=${recovery.blockerReasonCode} lastProgress=${text(recovery.lastProgressTick)} reminderAt=${text(recovery.reminderAtTick ?? 0)} reason=recovery-progress-unchanged`,
      );
    }
  }
  return lines;
}

function diagnosticLines(
  status: ReporterStatus,
  shardRef: string,
  tick: number,
): readonly string[] {
  const diagnostic = readDataRecord(status.diagnostic, ["level", "categories", "expiresAtTick"]);
  if (
    diagnostic === null ||
    (diagnostic.level !== "trace" && diagnostic.level !== "debug") ||
    !isNonNegativeInteger(diagnostic.expiresAtTick) ||
    diagnostic.expiresAtTick <= tick
  )
    return [];
  const categories = readBoundedDataArray(
    diagnostic.categories,
    MAXIMUM_RENDERABLE_DIAGNOSTIC_CATEGORIES,
  );
  if (categories === null) return [];
  const level = diagnostic.level === "trace" ? "TRACE" : "DEBUG";
  const prefix = `[MYRMEX][${level}][${shardRef}][t=${text(tick)}] diagnostic`;
  const lines: string[] = [];
  for (const category of categories) {
    switch (category) {
      case "recovery": {
        const stuck = status.recovery.stuck;
        lines.push(
          `${prefix} recovery required=${text(status.recovery.required)} stuck=${text(stuck?.active ?? false)} lastProgress=${text(stuck?.lastProgressTick ?? 0)} reminderAt=${text(stuck?.reminderAtTick ?? 0)}`,
        );
        break;
      }
      case "blockers":
        lines.push(`${prefix} blockers count=${text(arrayLength(status.blockers))}`);
        break;
      case "faults":
        lines.push(`${prefix} faults count=${text(arrayLength(status.faults))}`);
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

function readPolicy(policy: ConsoleReporterPolicy): ConsoleReporterPolicy | null {
  const baseLevel = policy.baseLevel;
  return (baseLevel === "silent" ||
    baseLevel === "error" ||
    baseLevel === "warn" ||
    baseLevel === "info" ||
    baseLevel === "debug" ||
    baseLevel === "trace") &&
    isPositiveInteger(policy.heartbeatIntervalTicks) &&
    isNonNegativeInteger(policy.maximumLinesPerTick) &&
    isNonNegativeInteger(policy.maximumBytesPerTick) &&
    isNonNegativeInteger(policy.maximumImmediateEventsPerTick) &&
    policy.maximumImmediateEventsPerTick <= MAXIMUM_RENDERABLE_TRANSITIONS
    ? {
        baseLevel,
        heartbeatIntervalTicks: policy.heartbeatIntervalTicks,
        maximumLinesPerTick: policy.maximumLinesPerTick,
        maximumBytesPerTick: policy.maximumBytesPerTick,
        maximumImmediateEventsPerTick: policy.maximumImmediateEventsPerTick,
      }
    : null;
}

function text(value: unknown): string {
  if (typeof value === "boolean") return String(value);
  return isNonNegativeInteger(value) ? String(value) : "0";
}

function strictBoolean(value: unknown): boolean {
  return value === true;
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

function readBoundedDataArray(value: unknown, maximumLength: number): readonly unknown[] | null {
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
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (entry === undefined || !("value" in entry)) return null;
      output.push(entry.value);
    }
    return output;
  } catch {
    return null;
  }
}

function readDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  try {
    if (!isRecord(value)) return null;
    const output: Record<string, unknown> = {};
    for (const key of expected) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (field === undefined || !field.enumerable || !("value" in field)) return null;
      output[key] = field.value;
    }
    return output;
  } catch {
    return null;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function scaledMilli(value: unknown): number {
  if (!isNonNegativeInteger(value)) return 0;
  return value > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
    ? Number.MAX_SAFE_INTEGER
    : value * 1_000;
}

function arrayLength(value: unknown): number {
  try {
    if (!Array.isArray(value)) return 0;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    return length !== undefined && "value" in length && isNonNegativeInteger(length.value)
      ? length.value
      : 0;
  } catch {
    return 0;
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        bytes += 4;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
