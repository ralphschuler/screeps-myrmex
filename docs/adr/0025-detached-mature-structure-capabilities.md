# ADR 0025: Detached mature-structure capabilities

## Status

Accepted

## Context

Factories, power spawns, observers, and nukers expose different live fields and depend on
source-controlled recipes, capacities, ranges, effects, and cooldowns. Retaining those live objects
or reading global constants inside policy would bypass the sole world-observation boundary and make
heap-reset behavior depend on adapter identity.

## Decision

`WorldObserver` projects each owned mature structure into sorted immutable plain data. Effects and
stores are copied under explicit bounds. A pure industry adapter validates and normalizes commodity
recipes, resource identities, and mature constants, then derives deterministic capability
fingerprints from that catalog and the current snapshot.

Malformed, oversized, cyclic, unknown-resource, or unsupported-level mechanics fail closed. This
boundary publishes facts only. It does not reserve resources, choose production, arbitrate observer
slots, or authorize factory, power-spawn, observer, or nuker commands.

## Consequences

- Policy and executors can consume stable facts without reading live structures or global tables.
- Generic stored-structure facts remain available to the sole logistics authority; mature snapshots
  do not create a second stock ledger.
- Recipe or capability changes produce new fingerprints after effects, levels, constants, or stores
  change and reproduce byte-for-byte after heap reset.
- Logistics composition and command authority remain separate follow-up decisions under issue #52.
