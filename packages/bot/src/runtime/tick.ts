import type { RuntimeGame, TickContext } from "./context";
import { runPhases, type TickPhase } from "./phases";
import { observeWorld } from "../world/observe";
import { ensureMyrmexMemory } from "../state/memory";
import { recordTickTelemetry } from "../telemetry/metrics";

export interface TickInput {
  readonly game: RuntimeGame;
  readonly memory: Memory;
  readonly onPhase?: (phase: TickPhase) => void;
}

export function runTick(input: TickInput): void {
  const state = ensureMyrmexMemory(input.memory, input.game.time, input.game.shard.name);
  const context: TickContext = { game: input.game, memory: input.memory, state };

  runPhases(context, {
    boot: () => input.onPhase?.("boot"),
    observe: (tick) => {
      input.onPhase?.("observe");
      tick.state.world = observeWorld(tick.game);
    },
    safety: () => input.onPhase?.("safety"),
    plan: () => input.onPhase?.("plan"),
    execute: () => input.onPhase?.("execute"),
    reconcile: () => input.onPhase?.("reconcile"),
    telemetry: (tick) => {
      input.onPhase?.("telemetry");
      recordTickTelemetry(tick);
    },
  });

  state.boot.lastTick = input.game.time;
}
