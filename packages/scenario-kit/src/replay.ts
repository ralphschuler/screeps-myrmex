import { canonicalClone, canonicalHash, canonicalSerialize } from "./canonical";
import {
  createSeededRandom,
  type DeterministicRandom,
  type ScenarioSeed,
  validateSeed,
} from "./random";

export const SCENARIO_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const MAX_SCENARIO_TICKS = 10_000;
export const MAX_SCENARIO_VALUE_LENGTH = 1_000_000;
export const MAX_SCENARIO_TRANSCRIPT_LENGTH = 10_000_000;

export interface ScenarioTick<Input> {
  /** Value modeled as Game.time for this tick. */
  readonly gameTime: number;
  /** Complete external input visible at the beginning of this tick. */
  readonly input: Input;
  /** Maximum modeled CPU units allowed for this tick. */
  readonly cpuBudget: number;
  /** Reconstruct volatile heap state before executing this tick. */
  readonly resetHeap?: boolean;
}

export interface ScenarioHeapContext<World, Input> {
  readonly scenarioId: string;
  readonly seed: ScenarioSeed;
  readonly tickIndex: number;
  readonly gameTime: number;
  readonly input: Input;
  readonly world: World;
  readonly reason: "initial" | "reset";
}

export interface ScenarioStepContext<World, Input, Heap extends object> {
  readonly scenarioId: string;
  readonly tickIndex: number;
  readonly gameTime: number;
  readonly input: Input;
  /** Immutable-by-contract beginning-of-tick game snapshot. */
  readonly world: World;
  /** Volatile, reconstructible state that does not enter the transcript. */
  readonly heap: Heap;
  readonly heapReset: boolean;
  readonly random: DeterministicRandom;
}

export interface ScenarioStepResult<World, Outcome, Heap extends object> {
  /** World snapshot visible at the beginning of the following tick. */
  readonly nextWorld: World;
  /** Explicit commands, observations, or domain result produced by this tick. */
  readonly outcome: Outcome;
  /** Deterministic modeled CPU consumption for this tick. */
  readonly cpuUsed: number;
  /** Optional replacement for the otherwise retained (and possibly mutated) heap. */
  readonly heap?: Heap;
}

export interface ScenarioCpuMeasurement<Input, Outcome> {
  readonly scenarioId: string;
  readonly tickIndex: number;
  readonly gameTime: number;
  readonly input: Input;
  readonly outcome: Outcome;
  readonly budget: number;
  readonly used: number;
  readonly remaining: number;
}

export interface ScenarioTickTranscript<World, Input, Outcome> {
  readonly tickIndex: number;
  readonly gameTime: number;
  readonly heapReset: boolean;
  readonly input: Input;
  readonly world: World;
  readonly nextWorld: World;
  readonly outcome: Outcome;
  readonly cpu: {
    readonly budget: number;
    readonly used: number;
    readonly remaining: number;
  };
  readonly random: {
    readonly draws: number;
    readonly state: number;
  };
}

export interface ScenarioTranscript<World, Input, Outcome> {
  readonly schemaVersion: typeof SCENARIO_TRANSCRIPT_SCHEMA_VERSION;
  readonly scenarioId: string;
  readonly seed: ScenarioSeed;
  readonly initialWorld: World;
  readonly ticks: readonly ScenarioTickTranscript<World, Input, Outcome>[];
  readonly finalWorld: World;
}

export interface ScenarioRunResult<World, Input, Outcome> {
  readonly transcript: ScenarioTranscript<World, Input, Outcome>;
  readonly transcriptHash: string;
  /** Hash of domain outcomes/world transitions, deliberately ignoring heap resets and CPU. */
  readonly outcomeHash: string;
  readonly outcomes: readonly Outcome[];
  readonly finalWorld: World;
}

export interface ReplayScenario<
  World,
  Input,
  Outcome,
  Heap extends object = Record<string, never>,
> {
  readonly id: string;
  readonly seed: ScenarioSeed;
  readonly initialWorld: World;
  readonly ticks: readonly ScenarioTick<Input>[];
  readonly createHeap?: (context: ScenarioHeapContext<World, Input>) => Heap;
  readonly resetHeap?: (context: ScenarioHeapContext<World, Input>) => Heap;
  readonly step: (
    context: ScenarioStepContext<World, Input, Heap>,
  ) => ScenarioStepResult<World, Outcome, Heap>;
  readonly assertCpu?: (measurement: ScenarioCpuMeasurement<Input, Outcome>) => void;
  readonly assertTick?: (tick: ScenarioTickTranscript<World, Input, Outcome>) => void;
  readonly verify?: (result: ScenarioRunResult<World, Input, Outcome>) => void;
}

export class ScenarioCpuBudgetError extends Error {
  public readonly budget: number;
  public readonly gameTime: number;
  public readonly scenarioId: string;
  public readonly used: number;

  public constructor(scenarioId: string, gameTime: number, budget: number, used: number) {
    super(
      `Scenario "${scenarioId}" exceeded its CPU budget at game time ${String(gameTime)}: ` +
        `${String(used)} used, ${String(budget)} allowed.`,
    );
    this.name = "ScenarioCpuBudgetError";
    this.scenarioId = scenarioId;
    this.gameTime = gameTime;
    this.budget = budget;
    this.used = used;
  }
}

export class ScenarioExecutionError extends Error {
  public readonly cause: unknown;
  public readonly gameTime: number;
  public readonly scenarioId: string;

  public constructor(scenarioId: string, gameTime: number, cause: unknown) {
    super(`Scenario "${scenarioId}" failed while executing game time ${String(gameTime)}.`);
    this.name = "ScenarioExecutionError";
    this.scenarioId = scenarioId;
    this.gameTime = gameTime;
    this.cause = cause;
  }
}

export function defineReplayScenario<
  World,
  Input,
  Outcome,
  Heap extends object = Record<string, never>,
>(
  scenario: ReplayScenario<World, Input, Outcome, Heap>,
): ReplayScenario<World, Input, Outcome, Heap> {
  validateScenarioId(scenario.id);
  validateSeed(scenario.seed);
  assertCanonicalSize(scenario.initialWorld, "initial world");

  if (scenario.ticks.length === 0) {
    throw new Error("A replay scenario must contain at least one tick.");
  }
  if (scenario.ticks.length > MAX_SCENARIO_TICKS) {
    throw new Error(`A replay scenario may contain at most ${String(MAX_SCENARIO_TICKS)} ticks.`);
  }

  let previousGameTime: number | undefined;
  const ticks = scenario.ticks.map((tick, tickIndex) => {
    validateTick(tick, tickIndex, previousGameTime);
    previousGameTime = tick.gameTime;

    return Object.freeze({
      gameTime: tick.gameTime,
      input: canonicalClone(tick.input),
      cpuBudget: tick.cpuBudget,
      resetHeap: tick.resetHeap === true,
    });
  });

  return Object.freeze({
    ...scenario,
    initialWorld: canonicalClone(scenario.initialWorld),
    ticks: Object.freeze(ticks),
  });
}

export function runScenario<World, Input, Outcome, Heap extends object>(
  scenarioDefinition: ReplayScenario<World, Input, Outcome, Heap>,
): ScenarioRunResult<World, Input, Outcome> {
  const scenario = defineReplayScenario(scenarioDefinition);
  const random = createSeededRandom(scenario.seed);
  const initialWorld = canonicalClone(scenario.initialWorld);
  let world = canonicalClone(initialWorld);
  const firstTick = scenario.ticks[0] as ScenarioTick<Input>;
  let heap = buildHeap(scenario, {
    scenarioId: scenario.id,
    seed: scenario.seed,
    tickIndex: 0,
    gameTime: firstTick.gameTime,
    input: canonicalClone(firstTick.input),
    world: canonicalClone(world),
    reason: "initial",
  });
  const tickTranscripts: ScenarioTickTranscript<World, Input, Outcome>[] = [];

  for (let tickIndex = 0; tickIndex < scenario.ticks.length; tickIndex += 1) {
    const tick = scenario.ticks[tickIndex] as ScenarioTick<Input>;
    const input = freezeCanonical(canonicalClone(tick.input));
    const worldAtStart = freezeCanonical(canonicalClone(world));
    const heapReset = tick.resetHeap === true;

    if (heapReset) {
      heap = rebuildHeap(scenario, {
        scenarioId: scenario.id,
        seed: scenario.seed,
        tickIndex,
        gameTime: tick.gameTime,
        input: canonicalClone(input),
        world: canonicalClone(worldAtStart),
        reason: "reset",
      });
    }

    let rawStepResult: unknown;
    try {
      rawStepResult = scenario.step(
        Object.freeze({
          scenarioId: scenario.id,
          tickIndex,
          gameTime: tick.gameTime,
          input,
          world: worldAtStart,
          heap,
          heapReset,
          random,
        }),
      );
    } catch (error: unknown) {
      throw new ScenarioExecutionError(scenario.id, tick.gameTime, error);
    }

    const stepResult = normalizeStepResult<World, Outcome, Heap>(
      rawStepResult,
      scenario.id,
      tick.gameTime,
    );
    const nextWorld = canonicalClone(stepResult.nextWorld);
    const outcome = canonicalClone(stepResult.outcome);
    const remaining = tick.cpuBudget - stepResult.cpuUsed;

    if (stepResult.cpuUsed > tick.cpuBudget) {
      throw new ScenarioCpuBudgetError(
        scenario.id,
        tick.gameTime,
        tick.cpuBudget,
        stepResult.cpuUsed,
      );
    }

    const measurement = Object.freeze({
      scenarioId: scenario.id,
      tickIndex,
      gameTime: tick.gameTime,
      input: canonicalClone(input),
      outcome: canonicalClone(outcome),
      budget: tick.cpuBudget,
      used: stepResult.cpuUsed,
      remaining,
    });
    scenario.assertCpu?.(measurement);

    const transcript = freezeCanonical({
      tickIndex,
      gameTime: tick.gameTime,
      heapReset,
      input,
      world: worldAtStart,
      nextWorld,
      outcome,
      cpu: {
        budget: tick.cpuBudget,
        used: stepResult.cpuUsed,
        remaining,
      },
      random: {
        draws: random.draws,
        state: random.state,
      },
    });
    scenario.assertTick?.(transcript);
    tickTranscripts.push(transcript);

    world = nextWorld;
    if (stepResult.heap !== undefined) {
      heap = stepResult.heap;
    }
  }

  const transcript = freezeCanonical({
    schemaVersion: SCENARIO_TRANSCRIPT_SCHEMA_VERSION,
    scenarioId: scenario.id,
    seed: scenario.seed,
    initialWorld,
    ticks: tickTranscripts,
    finalWorld: world,
  });
  const serializedTranscript = canonicalSerialize(transcript);
  if (serializedTranscript.length > MAX_SCENARIO_TRANSCRIPT_LENGTH) {
    throw new RangeError(
      `Scenario transcript exceeds ${String(MAX_SCENARIO_TRANSCRIPT_LENGTH)} code units.`,
    );
  }
  const outcomes = Object.freeze(transcript.ticks.map((tick) => tick.outcome));
  const result = Object.freeze({
    transcript,
    transcriptHash: canonicalHash(transcript),
    outcomeHash: canonicalHash({
      scenarioId: transcript.scenarioId,
      seed: transcript.seed,
      initialWorld: transcript.initialWorld,
      ticks: transcript.ticks.map((tick) => ({
        gameTime: tick.gameTime,
        world: tick.world,
        nextWorld: tick.nextWorld,
        outcome: tick.outcome,
      })),
      finalWorld: transcript.finalWorld,
    }),
    outcomes,
    finalWorld: transcript.finalWorld,
  });

  scenario.verify?.(result);
  return result;
}

/** Serialize a transcript as a stable one-line JSON record for CI artifacts/logs. */
export function serializeScenarioTranscript<World, Input, Outcome>(
  transcript: ScenarioTranscript<World, Input, Outcome>,
): string {
  return `${canonicalSerialize(transcript)}\n`;
}

function buildHeap<World, Input, Outcome, Heap extends object>(
  scenario: ReplayScenario<World, Input, Outcome, Heap>,
  context: ScenarioHeapContext<World, Input>,
): Heap {
  return validateHeap(scenario.createHeap?.(Object.freeze(context)) ?? {}) as Heap;
}

function rebuildHeap<World, Input, Outcome, Heap extends object>(
  scenario: ReplayScenario<World, Input, Outcome, Heap>,
  context: ScenarioHeapContext<World, Input>,
): Heap {
  if (scenario.resetHeap !== undefined) {
    return validateHeap(scenario.resetHeap(Object.freeze(context))) as Heap;
  }

  return buildHeap(scenario, context);
}

function validateScenarioId(id: string): void {
  if (id.trim().length === 0) {
    throw new Error("A scenario requires a stable, non-empty id.");
  }
}

function validateTick<Input>(
  tick: ScenarioTick<Input>,
  tickIndex: number,
  previousGameTime: number | undefined,
): void {
  if (!Number.isSafeInteger(tick.gameTime) || tick.gameTime < 0) {
    throw new Error(`Replay tick ${String(tickIndex)} requires a non-negative safe game time.`);
  }

  if (previousGameTime !== undefined && tick.gameTime !== previousGameTime + 1) {
    throw new Error(
      `Replay tick ${String(tickIndex)} must follow game time ${String(previousGameTime)} consecutively.`,
    );
  }

  if (!Number.isFinite(tick.cpuBudget) || tick.cpuBudget < 0) {
    throw new Error(`Replay tick ${String(tickIndex)} requires a finite, non-negative CPU budget.`);
  }

  assertCanonicalSize(tick.input, `input for replay tick ${String(tickIndex)}`);
}

function normalizeStepResult<World, Outcome, Heap extends object>(
  result: unknown,
  scenarioId: string,
  gameTime: number,
): ScenarioStepResult<World, Outcome, Heap> {
  if (typeof result !== "object" || result === null) {
    throw new TypeError(
      `Scenario "${scenarioId}" returned no step result at game time ${String(gameTime)}.`,
    );
  }

  const prototype = Object.getPrototypeOf(result) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `Scenario "${scenarioId}" returned a non-plain step result at game time ${String(gameTime)}.`,
    );
  }
  const nextWorld = readDataProperty(result, "nextWorld", true) as World;
  const outcome = readDataProperty(result, "outcome", true) as Outcome;
  const cpuUsed = readDataProperty(result, "cpuUsed", true);
  const heap = readDataProperty(result, "heap", false);
  if (typeof cpuUsed !== "number" || !Number.isFinite(cpuUsed) || cpuUsed < 0) {
    throw new TypeError(
      `Scenario "${scenarioId}" returned invalid CPU usage at game time ${String(gameTime)}.`,
    );
  }

  assertCanonicalSize(nextWorld, `next world at game time ${String(gameTime)}`);
  assertCanonicalSize(outcome, `outcome at game time ${String(gameTime)}`);
  return {
    nextWorld,
    outcome,
    cpuUsed,
    ...(heap === undefined ? {} : { heap: validateHeap(heap) as Heap }),
  };
}

function readDataProperty(value: object, property: string, required: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (descriptor === undefined) {
    if (required) {
      throw new TypeError(`Scenario step result is missing ${property}.`);
    }
    return undefined;
  }
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`Scenario step result ${property} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function validateHeap(heap: unknown): object {
  if (typeof heap !== "object" || heap === null) {
    throw new TypeError("Scenario heap factories must return a non-null object.");
  }
  let then: unknown;
  try {
    then = (heap as { readonly then?: unknown }).then;
  } catch {
    throw new TypeError("Scenario heap must not be an unreadable thenable.");
  }
  if (typeof then === "function") {
    throw new TypeError("Scenario heap must be synchronous, not a Promise.");
  }
  return heap;
}

function assertCanonicalSize(value: unknown, label: string): void {
  const serialized = canonicalSerialize(value);
  if (serialized.length > MAX_SCENARIO_VALUE_LENGTH) {
    throw new RangeError(
      `${label} exceeds ${String(MAX_SCENARIO_VALUE_LENGTH)} canonical code units.`,
    );
  }
}

function freezeCanonical<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    freezeCanonical(child);
  }

  return Object.freeze(value);
}
