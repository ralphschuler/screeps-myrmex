# ADR 0028: Mature runtime composition and shared receipt persistence

## Status

Accepted

## Context

Factory, power-spawn, observer, and nuker-stock authorities existed as bounded pure policies and
executors, but they were not connected to the static tick graph. Factory and power commands could
therefore not receive current colony funding, enter shared arbitration, or persist an exact
next-observation receipt. Observer receipts also had no reset-safe owner. Adding independent queues
or owners would duplicate the existing colony budget, logistics, intent, and industry authorities.

## Decision

- `phase2.mature` is source-available under `runtime-config-source-v27`, after `phase2.labs`. An
  operational override may disable it but cannot activate any unfinished successor.
- Source mechanics are normalized before mature work. Current owned-room facts derive factory,
  power-spawn, observer, and nuker capabilities; malformed or over-cap mechanics authorize nothing.
- Mature factory candidates target the existing source-controlled stock minimum. Components, power,
  ghodium, and energy below stock minima remain protected; terminal energy and current lab fills
  receive additional protection. One objective requests at most one factory batch per tick.
- Mature objectives request integer milli-CPU from `ColonyDirector`. Their storage/terminal
  resources remain protected and reserved by mature policy plus the sole logistics graph; they do
  not claim the spawn/extension energy pool as if stored industry stock were current room energy.
- Lab and mature demands merge only as data before `LogisticsPlanner`. Logistics retains sole flow
  admission, reservation, contract, and lease authority.
- `industry.publish` submits terminal, lab, mature, and observer intents to the shared intent
  channel. Mandatory-tail `industry.execute` follows shared arbitration and delegates only to the
  existing sole executors. Mandatory `industry.reconcile` runs before the atomic root commit.
- `IndustryOwnerV5` adds at most 64 mature commitments and 64 observer attempts while preserving V4
  terminal, lab, and mature-attempt state. One `industry` transaction persists all command receipts
  and commitments atomically. It stores no live object, mechanics catalog, or world snapshot.
- Mature planning runs only in normal or surplus CPU modes and only when a mature structure is
  observed. Lower CPU modes preserve owner bytes and authorize no mature command.
- Phase 2 defines no observer target strategy. The runtime composes an empty request set until a
  later authorized intel consumer emits typed requests; ADR 0027 remains the sole request and
  command authority.
- `launchNuke` is forbidden across the deployable source until an operations-authorized later phase
  explicitly changes that boundary.

## Consequences

Factory and operated-power effects survive heap reset as pending evidence and settle only from exact
next-tick deltas. Observer contention and visibility settlement use the same bounded authority when
a consumer exists. Nuker energy and ghodium can enter logistics only up to source caps, without
adding a launch path. Optional mature work cannot consume protected stock or displace survival work
under CPU pressure.

The owner migration adds bounded persistent data: 64 mature commitments, 64 mature attempts, and 64
observer attempts. Telemetry remains fixed-cardinality and observer-only. Checked evidence is in
[`phase2-mature-results.json`](../phase2-mature-results.json) and the proof matrix is in
[`phase2-mature-evidence.md`](../phase2-mature-evidence.md).

## Mechanics sources

- [Official `StructureFactory.produce`](https://docs.screeps.com/api/#StructureFactory.produce)
- [Official `StructurePowerSpawn.processPower`](https://docs.screeps.com/api/#StructurePowerSpawn.processPower)
- [Official `StructureObserver.observeRoom`](https://docs.screeps.com/api/#StructureObserver.observeRoom)
- [Official `StructureNuker`](https://docs.screeps.com/api/#StructureNuker)
- [Screeps Wiki: StructureFactory](https://wiki.screepspl.us/StructureFactory/)
- [Screeps Wiki: Power](https://wiki.screepspl.us/Power/)
- [Screeps Wiki: Vision](https://wiki.screepspl.us/Vision/)
- [Screeps Wiki: Energy](https://wiki.screepspl.us/Energy/)
