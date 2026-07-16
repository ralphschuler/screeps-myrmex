# Phase 1 economy evidence

Issue #26 enables `phase1.economy` at `runtime-config-source-v7`.

The bounded `EconomyPlanner` selects nearest visible energy sources and owned spawn/extension sinks
with stable identities and admits at most one worker reservation per observed source or sink per
tick. Its contract requests are funded only through `ColonyDirector`'s `harvesting-filling` budget
category and contain no energy or spawn claim; the minimal CPU claim is scheduling metadata only.
The protected emergency-recovery energy reserve therefore remains unavailable to ordinary filling
work.

The planner consumes the sanitized `ContractPlanningView` to re-fund suspended source or sink work
and cancel a replaced endpoint. Lease agents remain stateless and only submit correlated
action/movement intents; command success and next-tick observation control lifecycle progress.

Focused tests cover deterministic source/sink selection, protected-energy exclusion, bounded
renewal, suspended-work re-funding after unavailable endpoints, endpoint replacement, cargo-aware
allocation, zero-creep recovery through a simulated heap reset, harvest, positive delivery, and
tick-local energy-flow accounting.
