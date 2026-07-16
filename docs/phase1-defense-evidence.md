# Phase 1 Safety Evidence

Evidence version: `phase1-defense-v1`

Roadmap outcome: [issue #29](https://github.com/ralphschuler/screeps-myrmex/issues/29).

## Executable outcome

`DefenseDirector` runs in the mandatory Safety phase after Observe. It excludes configured self,
ally, and NAP identities before selecting a target, emits one exclusive typed action per tower, and
permits a safe-mode command only for a current owned controller with available activation, no active
safe mode/cooldown/upgrade block, qualifying local hostile offense, and predicted loss of a
critically damaged owned spawn or tower. The shared executor is the only live-command caller.

Tower attack, heal, and repair cost 10 energy. Repair is restricted to a critically damaged spawn,
requires `tower.repairMinimumEnergy`, and must leave `tower.emergencyReserveEnergy` after the
action. Critical healing preempts attack; ordinary repair never consumes a defense turn.

## Deterministic proof

- `defense-director.test.ts` covers configured ally/NAP exclusion, deterministic eligible targeting,
  critical healing precedence, reserve-gated repair, and legal/illegal safe-mode qualification.
- `tick.test.ts` proves the mandatory safety path reaches the exclusive tower and controller command
  adapters in one tick.
- `runtime-config.test.ts` proves `phase1.safety` is available only from source revision v8 and
  remains operator-disableable.

Repository validation is `npm run check`.

## Mechanics foundation

The following pages were consulted before implementation:

- [Screeps API: StructureTower](https://docs.screeps.com/api/#StructureTower), for owned tower
  attack/heal/repair methods;
- [Screeps API: StructureController.activateSafeMode](https://docs.screeps.com/api/#StructureController-activateSafeMode),
  for availability, cooldown, ownership, and return-code legality;
- [Screeps defense guide](https://docs.screeps.com/defense.html), for 10-energy tower actions,
  whole-room range, safe-mode last-resort posture, and one-safe-mode-per-shard constraint;
- [Screeps Wiki](https://wiki.screepspl.us/), consulted for community terminology and operational
  cross-checking.
