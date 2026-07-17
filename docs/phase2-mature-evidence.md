# Phase 2 Mature Infrastructure Evidence

Issue: [#267](https://github.com/ralphschuler/screeps-myrmex/issues/267)

Roadmap: Phase 2 complete colony

Gate: `phase2.mature` under `runtime-config-source-v27`

## Outcome

The static tick graph now composes funded factory production, reserve-safe power processing, capped
nuker stocking, and the sole observer request authority. Factory, power, and observer `OK` results
remain pending until exact next-tick observation. All durable mature commitments and receipts use
one `IndustryOwnerV5` transaction before the atomic root commit.

Phase 3 still owns observer target strategy. Phase 2 provides the bounded request path but emits no
production request by itself. Nuke launch remains absent and architecture-forbidden.

## Foundation mechanics

- Official [`StructureFactory.produce`](https://docs.screeps.com/api/#StructureFactory.produce): one
  call schedules one recipe batch; exact components, output capacity, cooldown, level/effect, RCL,
  and ownership are revalidated by the sole executor.
- Official
  [`StructurePowerSpawn.processPower`](https://docs.screeps.com/api/#StructurePowerSpawn.processPower):
  base processing consumes one power and 50 energy; operated processing consumes the complete
  effect-adjusted amount.
- Official
  [`StructureObserver.observeRoom`](https://docs.screeps.com/api/#StructureObserver.observeRoom):
  one accepted request per observer and tick produces visibility on the next tick; normal range is
  ten rooms unless the observer has the current operate-observer effect.
- Official [`StructureNuker`](https://docs.screeps.com/api/#StructureNuker): energy and ghodium
  capacity constrain stocking. This outcome adds no launch authorization.
- Screeps Wiki [`StructureFactory`](https://wiki.screepspl.us/StructureFactory/),
  [`Power`](https://wiki.screepspl.us/Power/), [`Vision`](https://wiki.screepspl.us/Vision/), and
  [`Energy`](https://wiki.screepspl.us/Energy/) informed supply-chain, reserve, and visibility edge
  framing. Official API and engine behavior remain authoritative.

## Deterministic matrix

Checked output: [`phase2-mature-results.json`](phase2-mature-results.json)

| Outcome                    | Executable evidence                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory and power commands | Funded, ready commitments emit `factory.produce` and `power-spawn.process-power` through shared arbitration.                                                          |
| Exact settlement           | `runTick` persists V5 attempts, survives a JSON Memory reset, and settles exact factory component/product/cooldown plus power/energy deltas without a duplicate call. |
| Observer contention        | Two reordered requests produce stable winner `alpha`; `OK` settles only as `visible-next-tick`.                                                                       |
| Nuker stocking             | Logistics projects exactly energy and ghodium fills to official/source caps; no nuke intent or launch call exists.                                                    |
| Reserve safety             | Stock at the source minimum and protected terminal-energy floor emits zero source transfers; already staged factory/power stock remains executable.                   |
| Reset/reorder              | Mechanics, structure order, request order, and JSON reconstruction produce identical canonical evidence.                                                              |
| Invalid mechanics          | Malformed source mechanics return `deferred/invalid-input` and authorize no command.                                                                                  |
| CPU degradation            | Constrained mode emits no mature command and leaves the V5 owner byte-equivalent.                                                                                     |

## Budgets and bounds

- CPU: one mature objective requests 50–250 integer milli-CPU; mature planning runs only in normal
  or surplus mode and only when a mature structure is visible.
- Persistent Memory: V5 caps mature commitments, mature attempts, and observer attempts at 64 each.
  Factory attempts retain at most 64 affected store-resource entries.
- Resources: source stock minima and protected terminal energy are unavailable to mature work.
  Current lab fills add resource-specific protection. Logistics reserves each physical source and
  aggregate destination capacity.
- Commands: one accepted command per physical mature structure or observer per tick. Executors are
  sole API callers. `launchNuke` is forbidden by the architecture checker.

## Validation

```text
npx vitest run packages/bot/test/mature-composition.test.ts
npx vitest run packages/bot/test/mature-infrastructure-runtime.test.ts
npx vitest run packages/bot/test/observer-authority.test.ts
npx vitest run packages/bot/test/industry-persistence.test.ts
npx vitest run packages/scenario-kit/test/phase2-mature-gate.test.ts
npm run check
```

The exact deployable bundle hash remains recorded in `phase1-gate-results.json`; bundle validation
also proves Scenario Kit is absent from the runtime graph.
