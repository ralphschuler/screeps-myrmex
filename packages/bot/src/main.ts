import { ConsoleReporter } from "./telemetry";
import { runTick } from "./runtime/tick";

const consoleReporter = new ConsoleReporter();

/** Screeps calls this exported function once per game tick. */
export function loop(): void {
  const outcome = runTick({ game: Game, memory: Memory });
  consoleReporter.report(outcome.reporterStatus, outcome.config.policy.reporter);
}
