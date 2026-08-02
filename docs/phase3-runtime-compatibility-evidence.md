# Phase 3 Current-Runtime Compatibility Evidence

This is rolling compatibility evidence, not a replacement for the closed Phase 3 gate receipt in
[`phase3-gate-results.json`](phase3-gate-results.json). The historical v28 receipt and its semantic
hash remain immutable.

Scenario `phase3/portfolio/current-runtime-compatibility-v1` executes production
`packages/bot/src/runtime/tick.runTick` for 30 ticks in each of warm, heap-reset, and reordered
variants. Under `runtime-config-source-v29` and policy revision `fnv1a64-utf16:2fa13822451badb4`,
all three variants produce semantic hash `fnv1a64-utf16:77f8f5140411e87d`.

The current compatibility receipt preserves the accepted remote behavior: final room `W1N3` is
active, threat/route/vision/value/source-loss transitions remain present, six V4/V5/V6 contracts are
observed through the validated ContractLedger projection, expected spawn errors remain typed, and
kernel faults are exactly zero. Complete Memory remains at most 65,536 bytes and the remotes owner
remains at most 32,768 bytes.

Reproduce with:

```sh
npx vitest run packages/scenario-kit/test/phase3-runtime-compatibility-gate.test.ts
```
