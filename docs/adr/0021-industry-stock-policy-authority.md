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

`TerminalSendExecutor` is the sole owner of live `StructureTerminal.send` calls. Only funded typed
intents accepted by the shared intent arbiter reach it. Normalized command results feed bounded
backoff, retirement, and accounting telemetry; the executor cannot alter stock policy.

Stock bands are explicit `min`, `target`, and `max` values. Extraction requires a funded deficit,
active RCL6 extractor, available mineral, and destination capacity. Internal sends preserve source
minimums and protected energy, respect destination maximum/free capacity and terminal cooldown, and
include transaction energy in affordability.

Recurring extraction keeps one active request byte-stable. ContractLedger's sanitized frontier
projection supplies the exact next issuer generation after expiry or depletion, including later
regeneration of the same mineral object ID. Rolling industry budgets retain their current request
until renewal is due and advance revision whenever signed expiry or resource claims change. Neither
path reuses a terminal sequence or mutates one revision in place.

The shared Lease Agent and Movement target projection includes the observed mineral ID. Extraction
contracts may require `WORK` and `MOVE` with zero `CARRY`; that body is executable because harvest
overflow intentionally drops at the work tile. Carry-bearing harvesters retain the ordinary
free-capacity guard. Industry requests express CPU exclusively as integer milli-CPU, matching the
BudgetLedger schema.

Extraction and internal-send reservations are conditional until publication settles before colony
persistence. An exact same-tick extraction bootstrap retains its binding until contract
reconciliation, including a successor generation reusing an older rolling grant; without it, the
exact live mineral contract is required. A send grant requires a current typed terminal intent.
Missing evidence releases only current extraction/send bindings; lab and mature-infrastructure
grants sharing the `industry` category remain outside this settlement scope. If contract planning is
unavailable, new extraction contracts fail closed while older extraction grants are preserved until
authority returns.

## Consequences

- Reordered or reset inputs produce the same proposal identities and accounting.
- Depletion, cooldown, missing destinations, full stores, and proposal caps defer without commands.
- Mineral extraction remains executable through the ordinary contract, lease, movement, and command
  chain instead of depending on an Industry-local actor path.
- Market trading, reactions, factories, power processing, and command execution remain outside this
  decision.
