import { canonicalSerialize } from "./canonical";

/** One initial sample plus the maximum number of replay ticks. */
export const MAX_ASSERTION_SAMPLES = 10_001;
export const MAX_ASSERTION_VALUE_LENGTH = 1_000_000;

export type ScenarioAssertionCode =
  | "forbidden-outcome-observed"
  | "outcome-deadline-missed"
  | "persistent-memory-growth-exceeded"
  | "required-outcome-missing";

export interface ScenarioAssertionOptions {
  /** Stable domain wording included in bounded failure messages. */
  readonly label?: string;
}

export type ScenarioAssertionPredicate<Sample> = (sample: Sample, index: number) => boolean;

export class ScenarioAssertionError extends Error {
  public readonly code: ScenarioAssertionCode;
  public readonly sampleIndex: number | null;

  public constructor(code: ScenarioAssertionCode, message: string, sampleIndex: number | null) {
    super(message);
    this.name = "ScenarioAssertionError";
    this.code = code;
    this.sampleIndex = sampleIndex;
  }
}

export interface PersistentMemoryGrowthOptions<Sample> extends ScenarioAssertionOptions {
  /** Maximum UTF-8 byte increase above the first selected Memory value. */
  readonly maximumGrowthBytes: number;
  /** Selects only persistent Memory; volatile world/heap data must stay outside this value. */
  readonly selectMemory: (sample: Sample, index: number) => unknown;
}

export interface PersistentMemoryGrowthMeasurement {
  readonly finalBytes: number;
  readonly growthBytes: number;
  readonly initialBytes: number;
  readonly peakBytes: number;
  readonly sampleCount: number;
}

export interface OutcomeDeadlineOptions<Sample> extends ScenarioAssertionOptions {
  /** Inclusive absolute deadline, normally modeled as Game.time. */
  readonly deadline: number;
  readonly selectGameTime: (sample: Sample, index: number) => number;
}

/** Require at least one matching sample and return the first deterministic match index. */
export function assertRequiredOutcome<Sample>(
  samples: readonly Sample[],
  matches: ScenarioAssertionPredicate<Sample>,
  options: ScenarioAssertionOptions = {},
): number {
  validateSamples(samples);
  validateFunction(matches, "outcome predicate");
  const label = normalizeLabel(options.label, "required outcome");

  for (let index = 0; index < samples.length; index += 1) {
    const sample = readSample(samples, index);
    if (evaluatePredicate(matches, sample, index)) {
      return index;
    }
  }

  throw new ScenarioAssertionError(
    "required-outcome-missing",
    `Scenario did not observe ${label} in ${String(samples.length)} bounded samples.`,
    null,
  );
}

/** Fail on the first forbidden match; every bounded sample is inspected exactly once. */
export function assertForbiddenOutcome<Sample>(
  samples: readonly Sample[],
  matches: ScenarioAssertionPredicate<Sample>,
  options: ScenarioAssertionOptions = {},
): void {
  validateSamples(samples);
  validateFunction(matches, "outcome predicate");
  const label = normalizeLabel(options.label, "forbidden outcome");

  for (let index = 0; index < samples.length; index += 1) {
    const sample = readSample(samples, index);
    if (evaluatePredicate(matches, sample, index)) {
      throw new ScenarioAssertionError(
        "forbidden-outcome-observed",
        `Scenario observed ${label} at sample ${String(index)}.`,
        index,
      );
    }
  }
}

/**
 * Assert peak serialized persistent Memory growth relative to the first sample.
 * Canonical key ordering does not change JSON byte length and makes the measurement repeatable.
 */
export function assertPersistentMemoryGrowthCap<Sample>(
  samples: readonly Sample[],
  options: PersistentMemoryGrowthOptions<Sample>,
): PersistentMemoryGrowthMeasurement {
  validateSamples(samples);
  if (samples.length === 0) {
    throw new RangeError("Persistent Memory growth requires at least one sample.");
  }
  validateFunction(options.selectMemory, "persistent Memory selector");
  const maximumGrowthBytes = nonNegativeSafeInteger(
    options.maximumGrowthBytes,
    "maximumGrowthBytes",
  );
  const label = normalizeLabel(options.label, "persistent Memory");

  let initialBytes = 0;
  let finalBytes = 0;
  let peakBytes = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = readSample(samples, index);
    const serialized = canonicalSerialize(options.selectMemory(sample, index));
    if (serialized.length > MAX_ASSERTION_VALUE_LENGTH) {
      throw new RangeError(
        `${label} at sample ${String(index)} exceeds the assertion value limit of ` +
          `${String(MAX_ASSERTION_VALUE_LENGTH)} canonical code units.`,
      );
    }

    const bytes = utf8ByteLength(serialized);
    if (index === 0) {
      initialBytes = bytes;
      peakBytes = bytes;
    }
    finalBytes = bytes;
    peakBytes = Math.max(peakBytes, bytes);
    const growthBytes = Math.max(0, bytes - initialBytes);
    if (growthBytes > maximumGrowthBytes) {
      throw new ScenarioAssertionError(
        "persistent-memory-growth-exceeded",
        `${label} grew by ${String(growthBytes)} bytes at sample ${String(index)}; ` +
          `the cap is ${String(maximumGrowthBytes)} bytes.`,
        index,
      );
    }
  }

  return Object.freeze({
    finalBytes,
    growthBytes: Math.max(0, peakBytes - initialBytes),
    initialBytes,
    peakBytes,
    sampleCount: samples.length,
  });
}

/** Require an outcome at or before an inclusive, monotonically ordered Game.time deadline. */
export function assertOutcomeByDeadline<Sample>(
  samples: readonly Sample[],
  matches: ScenarioAssertionPredicate<Sample>,
  options: OutcomeDeadlineOptions<Sample>,
): number {
  validateSamples(samples);
  validateFunction(matches, "outcome predicate");
  validateFunction(options.selectGameTime, "Game.time selector");
  const deadline = nonNegativeSafeInteger(options.deadline, "deadline");
  const label = normalizeLabel(options.label, "required outcome");
  let previousGameTime: number | null = null;
  let matchIndex: number | null = null;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = readSample(samples, index);
    const gameTime = nonNegativeSafeInteger(
      options.selectGameTime(sample, index),
      `Game.time at sample ${String(index)}`,
    );
    if (previousGameTime !== null && gameTime <= previousGameTime) {
      throw new RangeError(
        "Outcome deadline samples must use strictly increasing Game.time values.",
      );
    }
    previousGameTime = gameTime;

    if (matchIndex === null && gameTime <= deadline && evaluatePredicate(matches, sample, index)) {
      matchIndex = index;
    }
  }

  if (matchIndex !== null) {
    return matchIndex;
  }

  throw new ScenarioAssertionError(
    "outcome-deadline-missed",
    `Scenario did not observe ${label} by inclusive Game.time ${String(deadline)}.`,
    null,
  );
}

function validateSamples(samples: readonly unknown[]): void {
  if (!Array.isArray(samples)) {
    throw new TypeError("Scenario assertion samples must be an array.");
  }
  if (samples.length > MAX_ASSERTION_SAMPLES) {
    throw new RangeError(
      `Scenario assertions accept at most ${String(MAX_ASSERTION_SAMPLES)} samples.`,
    );
  }

  const ownKeys = Reflect.ownKeys(samples);
  if (ownKeys.some((key) => typeof key === "symbol") || ownKeys.length > samples.length + 1) {
    throw new TypeError("Scenario assertion samples must be a dense array without custom keys.");
  }
  for (let index = 0; index < samples.length; index += 1) {
    readSample(samples, index);
  }
}

function readSample<Sample>(samples: readonly Sample[], index: number): Sample {
  const descriptor = Object.getOwnPropertyDescriptor(samples, String(index));
  if (descriptor === undefined) {
    throw new TypeError(`Scenario assertion samples contain a sparse slot at ${String(index)}.`);
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(
      `Scenario assertion sample ${String(index)} must be an enumerable data item.`,
    );
  }
  return descriptor.value as Sample;
}

function evaluatePredicate<Sample>(
  predicate: ScenarioAssertionPredicate<Sample>,
  sample: Sample,
  index: number,
): boolean {
  const result = predicate(sample, index);
  if (typeof result !== "boolean") {
    throw new TypeError(`Outcome predicate at sample ${String(index)} must return a boolean.`);
  }
  return result;
}

function validateFunction(
  value: unknown,
  label: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function.`);
  }
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError("Scenario assertion label must be a non-empty, trimmed string.");
  }
  if (value.length > 128) {
    throw new RangeError("Scenario assertion label must not exceed 128 characters.");
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
