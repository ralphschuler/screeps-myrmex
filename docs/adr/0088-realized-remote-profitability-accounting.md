# ADR 0088: Realized remote profitability accounting

## Status

Accepted

## Context

ADR 0082 admits remotes from a full-cost forecast, while ADRs 0083–0087 can reserve, mine, haul,
lose, suspend, and evacuate work. The portfolio still cannot compare delivered value with settled
cost. Forecast-only admission can therefore retain a remote whose realized return is negative.

The accounting boundary must attribute value and cost without making `TelemetryService` a gameplay
reader or adding a second remote lifecycle, budget, contract, movement, or command authority. Phase
3 gate issue #63 still owns scheduled production composition and the complete portfolio soak.

## Decision

- `RemotePortfolio` remains the sole `remotes` owner and lifecycle authority. Its owner-local schema
  advances from V1 to V2. V1 records migrate byte-equivalently and receive an empty `accounting`
  collection; exact `{}` initializes V2. Older code sees V2 as future and fails closed.
- `reduceRemoteAccounting` is a pure reducer inside that authority. It accepts settled detached
  receipts only. It neither reads the world nor creates a budget, reservation, contract, intent,
  command, loss classification, or telemetry owner.
- One receipt attributes harvested and delivered energy plus disjoint spawn-energy, spawn-time,
  travel-time, reservation-energy, construction-energy, repair-energy, CPU, creep-loss, and downtime
  values. `deliveredEnergy` is realized revenue; harvesting is utilization evidence and is never
  counted as a second revenue source.
- Source policy converts spawn time, travel time, and milli-CPU to milli-energy shadow costs.
  Downtime uses that sample's portfolio forecast revenue. Direct energy costs use exact 1,000
  milli-energy per energy. The source defaults are strategic assumptions, not engine constants.
- Each remote retains a compact ordered ring of at most 50 samples in a 50-tick window. The current
  defaults require ten complete ticks, at least 8,000 basis-point coverage, and evidence no older
  than two ticks. A summary is `warming-up`, `profitable`, `marginal`, `loss-making`, `stale`, or
  `incomplete` and reports forecast variance, utilization, downtime, every cost component, and net
  rate.
- Forecast admission remains available while a new remote warms up. Once accounting exists,
  qualified realized loss, stale evidence, or incomplete evidence feeds the existing portfolio as
  `realized-negative`, `accounting-stale`, or `accounting-incomplete`. `RemotePortfolio` alone then
  suspends and releases all commitment dimensions. Threat and other safety blockers retain higher
  precedence.
- Accounting accepts at most eight observations and retains at most eight remote rings. Rings for
  non-evictable lifecycle records are protected; a new ring may evict only the oldest candidate or
  retired record's ring, otherwise the whole batch fails closed. Duplicate room observations,
  conflicting same-tick replay, malformed or future-tick values, unsafe arithmetic, and a ninth
  observation reject the whole batch without a prefix. Input reorder and heap reset preserve bytes.
- The complete V2 owner remains capped at 32,768 JSON code units. Portfolio fitting includes compact
  accounting bytes and may evict only already-evictable candidate/retired lifecycle records.
  Existing active commitments are never silently removed to fit accounting.
- Direct per-remote summaries may retain bounded stable room identities for their owning runtime
  consumer and tests. Aggregate metrics contain fixed counters and totals only; no player identity,
  unbounded label, or live tactical state reaches logs or durable telemetry.

## Consequences

Issue #62 can prove realized profitable, marginal, loss-making, threatened, stale, partial, reset,
reordered, and over-cap outcomes without a telemetry strategy loop. The owner migration is bounded
and needs no root-schema change. Missing or partial accounting reduces authorization after tracking;
it cannot invent delivery or hide loss.

The input contract deliberately requires upstream owners to supply settled, non-overlapping facts.
Issue #63 must compose those receipts from production mining, logistics, spawn, reservation,
construction, maintenance, CPU, and loss results before claiming the Phase 3 exit. This leaf does
not schedule another scan or claim MMO evidence.

Rollback requires no reverse migration. Older code preserves V2 as a future owner and authorizes no
new remote objective. Operators should let existing remote contracts suspend or cancel them before
rollback if immediate withdrawal is required.

## Mechanics sources

Reviewed 2026-07-28:

- Official [`Game.time`](https://docs.screeps.com/api/#Game.time): the global tick counter advances
  every tick, so it is the stable rolling-window coordinate.
- Official [`Game.cpu`](https://docs.screeps.com/api/#Game.cpu),
  [`Game.cpu.getUsed`](https://docs.screeps.com/api/#Game.cpu.getUsed), and
  [CPU limits](https://docs.screeps.com/cpu-limit.html): current use, assigned limit, tick limit,
  and bucket are distinct. Accounting consumes an already-attributed CPU delta and applies a source
  shadow price; it never self-admits from bucket state.
- Official [`Creep.harvest`](https://docs.screeps.com/api/#Creep.harvest): harvesting requires
  `WORK`, schedules an action, and drops output when no empty `CARRY` exists. Harvest receipts are
  utilization evidence, not proof of owned-sink delivery.
- Official [`StructureSpawn.spawnCreep`](https://docs.screeps.com/api/#StructureSpawn.spawnCreep),
  [`Creep.build`](https://docs.screeps.com/api/#Creep.build),
  [`Creep.repair`](https://docs.screeps.com/api/#Creep.repair), and
  [`Creep.reserveController`](https://docs.screeps.com/api/#Creep.reserveController): these commands
  consume or occupy distinct body, energy, spawn, and reservation resources, so their settled costs
  remain separately attributable.
- Official [`Room.getEventLog`](https://docs.screeps.com/api/#Room.getEventLog): events describe the
  previous tick. They may support an owning loss projection, but accounting itself does not infer
  hostile causality.
- Screeps Wiki [Remote Harvesting](https://wiki.screepspl.us/Remote_Harvesting/) and
  [CPU](https://wiki.screepspl.us/CPU/): community guidance separates vision, miners, haulers,
  reservation, roads, defense/loss, replacement, and CPU overhead. The Wiki informed attribution
  categories only; official mechanics and settled MYRMEX receipts govern.

No predecessor-bot or public-bot source was consulted.
