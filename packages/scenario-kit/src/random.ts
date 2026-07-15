import { canonicalSerialize } from "./canonical";

export type ScenarioSeed = number | string;

export interface DeterministicRandom {
  /** Number of values consumed from this stream. */
  readonly draws: number;
  /** Current uint32 generator state, useful in replay diagnostics. */
  readonly state: number;
  next(): number;
  integer(maxExclusive: number): number;
  boolean(probability?: number): boolean;
  pick<Value>(values: readonly Value[]): Value;
}

/** Create a fresh deterministic PRNG stream for a scenario run. */
export function createSeededRandom(seed: ScenarioSeed): DeterministicRandom {
  validateSeed(seed);
  return new Mulberry32(hashSeed(seed));
}

export function validateSeed(seed: ScenarioSeed): void {
  if (typeof seed !== "number" && typeof seed !== "string") {
    throw new TypeError("A scenario seed must be a string or safe integer.");
  }
  if (typeof seed === "number" && !Number.isSafeInteger(seed)) {
    throw new TypeError("A numeric scenario seed must be a safe integer.");
  }

  if (typeof seed === "string" && seed.length === 0) {
    throw new TypeError("A string scenario seed must not be empty.");
  }
}

class Mulberry32 implements DeterministicRandom {
  private currentState: number;
  private drawCount = 0;

  public constructor(seed: number) {
    this.currentState = seed >>> 0;
  }

  public get draws(): number {
    return this.drawCount;
  }

  public get state(): number {
    return this.currentState;
  }

  public next(): number {
    this.currentState = (this.currentState + 0x6d2b79f5) >>> 0;
    let mixed = this.currentState;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    this.drawCount += 1;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  }

  public integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError("A random integer bound must be a positive safe integer.");
    }

    return Math.floor(this.next() * maxExclusive);
  }

  public boolean(probability = 0.5): boolean {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError("A random boolean probability must be between 0 and 1.");
    }

    return this.next() < probability;
  }

  public pick<Value>(values: readonly Value[]): Value {
    if (values.length === 0) {
      throw new RangeError("Cannot pick a value from an empty collection.");
    }

    return values[this.integer(values.length)] as Value;
  }
}

function hashSeed(seed: ScenarioSeed): number {
  const serialized = canonicalSerialize(seed);
  let hash = 0x811c9dc5;

  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
}
