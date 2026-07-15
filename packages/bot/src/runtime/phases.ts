export const TICK_PHASES = [
  "boot",
  "observe",
  "safety",
  "plan",
  "execute",
  "reconcile",
  "telemetry",
] as const;

export type TickPhase = (typeof TICK_PHASES)[number];

export type PhaseHandler<Context> = (context: Context) => void;

export function runPhases<Context>(
  context: Context,
  handlers: Readonly<Record<TickPhase, PhaseHandler<Context>>>,
): void {
  for (const phase of TICK_PHASES) {
    handlers[phase](context);
  }
}
