import { runTick } from "./runtime/tick";

/** Screeps calls this exported function once per game tick. */
export function loop(): void {
  runTick({ game: Game, memory: Memory });
}
