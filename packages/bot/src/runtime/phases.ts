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
