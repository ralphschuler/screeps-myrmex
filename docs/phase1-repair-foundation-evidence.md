# Phase 1 repair foundation evidence

Source version: `runtime-config-source-v8`.

Issue [#122](https://github.com/ralphschuler/screeps-myrmex/issues/122) makes repair execution
threshold-aware and gives normalized repair command failures bounded deterministic retry behavior.
It does not select maintenance targets or budgets; that remains
[#40](https://github.com/ralphschuler/screeps-myrmex/issues/40).

## Outcome evidence

- A repair lease completes when observed hits reach its explicit `completionHits` threshold.
- ContractLedger-derived repair retries wait for capped exponential delay and fail once the
  configured attempt cap is exhausted.
- The focused lease-agent test covers threshold completion and retry timing; the full repository
  gate validates the existing contract, runtime, and architecture boundaries.

## Mechanics sources consulted

- [Screeps documentation: Creep.repair](https://docs.screeps.com/api/#Creep.repair)
- [Screeps documentation: Structure.hits](https://docs.screeps.com/api/#Structure-hits)
- [Screeps documentation: Screeps return codes](https://docs.screeps.com/api/#ErrorCodes)
- [Screeps Wiki](https://wiki.screepspl.us/)

The implementation treats live command results as evidence only. Current normalized snapshot hits
remain the proof that a repair objective is complete.
