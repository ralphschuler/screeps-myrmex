# ADR 0010: Defense director and structure command authority

Status: accepted

## Context

An owned room needs a mandatory, fail-closed response to present hostile creeps without allowing
role code, diplomacy evidence, or a planner to issue tower or controller commands directly.

## Decision

`DefenseDirector` is a pure current-tick selector. It reads the normalized room snapshot and the
immutable configured-relation view, emits one typed intent per tower and at most one safe-mode
intent per observed controller, and owns no persistent queue. Configured self, ally, and NAP
identities are excluded before target scoring; an unconfigured identity remains capped at local
defense.

The shared intent arbiter remains the sole admission boundary. `execution.defense` is the only
runtime system that resolves the same-snapshot tower/controller IDs and calls `attack`, `heal`,
`repair`, or `activateSafeMode`. A missing object or command exception is normalized by the shared
command executor and cannot cause a second account-wide lookup or mutation.

Safe mode has no durable retry state: a successful command is naturally suppressed by the next
controller snapshot, and a rejected command is reconsidered only from fresh current-tick evidence.
This avoids a new persistent authority before the Phase 1 telemetry/retry policy is implemented.

## Consequences

- Tower action ownership is explicit and one tower has one exclusive intent per tick.
- Critical healing preempts attack; critical spawn repair is allowed only above the configured tower
  reserve and never substitutes for the later critical-maintenance policy.
- Safe mode is limited to a legal observed controller, a qualifying local hostile, and a predicted
  near-term loss of a critically damaged owned spawn or tower.
- `phase1.safety` is source-available under `runtime-config-source-v8`.
