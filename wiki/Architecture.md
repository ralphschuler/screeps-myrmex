# Architecture

MYRMEX has one deployable runtime, one persistent-memory authority, one scheduler, and one
world-observation pipeline.

Each tick runs: **boot → observe → safety → plan → execute → reconcile → telemetry**.

Planners read immutable snapshots and emit typed intents. Executors arbitrate conflicts and issue
Screeps commands. Optional work is incremental and may be skipped under CPU pressure without
weakening survival, defense, spawning, or essential logistics.

The scenario-kit workspace is development-only and cannot be imported into the bot bundle.

See the repository's `docs/architecture.md` for the full authority map.
