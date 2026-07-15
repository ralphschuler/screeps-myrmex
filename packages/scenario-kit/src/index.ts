export interface Scenario<World> {
  readonly id: string;
  readonly initialWorld: World;
  readonly ticks: number;
  readonly verify: (world: World) => void;
}

export {
  MAX_ASSERTION_SAMPLES,
  MAX_ASSERTION_VALUE_LENGTH,
  ScenarioAssertionError,
  assertForbiddenOutcome,
  assertOutcomeByDeadline,
  assertPersistentMemoryGrowthCap,
  assertRequiredOutcome,
  type OutcomeDeadlineOptions,
  type PersistentMemoryGrowthMeasurement,
  type PersistentMemoryGrowthOptions,
  type ScenarioAssertionCode,
  type ScenarioAssertionOptions,
  type ScenarioAssertionPredicate,
} from "./assertions";
export {
  canonicalClone,
  canonicalHash,
  canonicalSerialize,
  type CanonicalJsonValue,
} from "./canonical";
export {
  SCENARIO_TRANSCRIPT_SCHEMA_VERSION,
  MAX_SCENARIO_TICKS,
  MAX_SCENARIO_TRANSCRIPT_LENGTH,
  MAX_SCENARIO_VALUE_LENGTH,
  ScenarioCpuBudgetError,
  ScenarioExecutionError,
  defineReplayScenario,
  runScenario,
  serializeScenarioTranscript,
  type ReplayScenario,
  type ScenarioCpuMeasurement,
  type ScenarioHeapContext,
  type ScenarioRunResult,
  type ScenarioStepContext,
  type ScenarioStepResult,
  type ScenarioTick,
  type ScenarioTickTranscript,
  type ScenarioTranscript,
} from "./replay";
export { createSeededRandom, type DeterministicRandom, type ScenarioSeed } from "./random";

export function defineScenario<World>(scenario: Scenario<World>): Scenario<World> {
  if (scenario.id.trim().length === 0) {
    throw new Error("A scenario requires a stable, non-empty id.");
  }

  if (!Number.isSafeInteger(scenario.ticks) || scenario.ticks < 1) {
    throw new Error("A scenario must run for at least one whole tick.");
  }

  return Object.freeze(scenario);
}
