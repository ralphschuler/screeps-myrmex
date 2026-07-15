# Phase 1 Lease-Agent Evidence

Primary slice: [issue #38](https://github.com/ralphschuler/screeps-myrmex/issues/38)

Lease agents consume only `ContractLedger.executionView()`, the current immutable world snapshot,
and the runtime-owned local path capability. They never receive a live room, creep, Memory manager,
contract ledger, or executor. Each actor can yield at most one action and one movement intent, both
correlated with the leased contract ID and revision.

## Outcome matrix

| Outcome                                                                      | Evidence                 |
| ---------------------------------------------------------------------------- | ------------------------ |
| Reordered leased input produces the same actor proposals                     | `lease-agent.test.ts`    |
| An out-of-range authorized harvest emits one bounded local movement proposal | `lease-agent.test.ts`    |
| In-range work emits one correlated primary action                            | `lease-agent.test.ts`    |
| Missing targets fail closed and request a ledger transition                  | `lease-agent.test.ts`    |
| Scheduled work activates only the matching assigned lease                    | `lease-agent.test.ts`    |
| Source gate enables only the completed agent slice                           | `runtime-config.test.ts` |

## Mechanics sources

The implementation follows the official [Creep API](https://docs.screeps.com/api/#Creep): harvest
requires `WORK` and range 1; transfer and withdraw are range-1 store operations; pickup needs
`CARRY` and accepts same-square/adjacent resources; build, repair, and controller upgrade consume
carried energy and use range 3. Store capacity/free/used APIs constrain empty/full fail-closed
behavior, and `ticksToLive` is the remaining game-tick lifetime. The
[Screeps game-loop guide](https://docs.screeps.com/game-loop.html) constrains the design to
current-tick observation and command evidence. The [Screeps Wiki](https://wiki.screepspl.us/) was
consulted for terminology and operational context; official API behavior takes precedence.
