# ADR 0022: Derived lab cluster roles

- Status: Accepted
- Date: 2026-07-17
- Issues: #51, #249

## Context

Owned labs have current activity, cooldown, mineral, energy, capacity, and geometry facts. Reactions
require two reagent labs and output labs within range two of both. Persisting general layout
placements or independent lab-role state would duplicate the layout authority and become stale after
lab loss, RCL changes, or layout revision.

## Decision

The world observer publishes detached owned-lab facts and grouped exact creep boost compounds.
Reaction tables and cooldowns cross the runtime boundary through a bounded canonical catalog rather
than being copied into policy or persistent Memory.

`IndustryDirector` derives lab cluster roles from the current sorted owned-lab IDs and positions
plus the existing layout fingerprint. The pure assignment selects exactly two reagent labs, admits
only output labs within range two of both, exposes bounded product and boost-capable role lists, and
emits a compact deterministic fingerprint. Missing, inactive, malformed, duplicate, non-adjacent, or
over-cap facts fail closed.

Assignments are reconstructible and are not stored by the layout or industry owner. A later lab
planner may persist funded commitments and settlement state, but it must rebuild roles when the
layout fingerprint or current lab set changes. Product and boost capability may overlap because the
future shared lab arbiter serializes the room cluster; this ADR grants no command authority.

## Consequences

- Input reordering and heap reset produce byte-equivalent roles.
- Layout revision, lab loss, or RCL inactivity changes or removes the assignment without migration.
- Exact boost settlement can distinguish compounds instead of relying on aggregate boosted counts.
- Reaction planning, logistics demands, commands, durable commitments, and gate activation remain
  outside this enabling slice.
