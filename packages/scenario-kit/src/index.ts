export interface Scenario<World> {
  readonly id: string;
  readonly initialWorld: World;
  readonly ticks: number;
  readonly verify: (world: World) => void;
}

export function defineScenario<World>(scenario: Scenario<World>): Scenario<World> {
  if (scenario.id.trim().length === 0) {
    throw new Error("A scenario requires a stable, non-empty id.");
  }

  if (!Number.isSafeInteger(scenario.ticks) || scenario.ticks < 1) {
    throw new Error("A scenario must run for at least one whole tick.");
  }

  return Object.freeze(scenario);
}
