# ADR 0021: Industry stock policy authority

- Status: Accepted
- Date: 2026-07-17
- Issue: #50

## Context

RCL6 colonies can extract minerals and send resources between owned terminals. These actions share
storage capacity and survival energy with the rest of the colony. Independent extraction and send
logic would oversubscribe stock, strand energy, and retry stale commands.

## Decision

`IndustryDirector` is the sole owner of stock bands and mineral commitments. Its pure planning
boundary consumes detached room, mineral, extractor, storage, terminal, commitment, and transaction
cost facts. It emits bounded extraction and internal-send proposals with stable identities and
explicit deferral counts.

The director never calls the Screeps API and owns no structure command slot. Existing budget,
contract, logistics, intent-arbitration, and executor authorities remain responsible for funding,
workforce movement, hauling, and commands. A later composition change will bind proposals to those
authorities and reconcile observed results.

Stock bands are explicit `min`, `target`, and `max` values. Extraction requires a funded deficit,
active RCL6 extractor, available mineral, and destination capacity. Internal sends preserve source
minimums and protected energy, respect destination maximum/free capacity and terminal cooldown, and
include transaction energy in affordability.

## Consequences

- Reordered or reset inputs produce the same proposal identities and accounting.
- Depletion, cooldown, missing destinations, full stores, and proposal caps defer without commands.
- Market trading, reactions, factories, power processing, and command execution remain outside this
  decision.
