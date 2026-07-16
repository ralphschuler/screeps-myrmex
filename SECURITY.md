# Security Policy

MYRMEX does not accept public reports containing Screeps credentials, deployment tokens, private
shard information, or unpublished operational intelligence.

Report security issues privately to the repository owner through GitHub's private vulnerability
reporting feature. Never open a public issue containing a token or secret. Rotate any exposed
credential immediately.

Only the current `main` branch receives security fixes during bootstrap.

Screeps automation uses a dedicated token stored only in the protected `screeps-production` GitHub
environment. Scope it to the documented deployment and recovery endpoints where Screeps token
controls allow. Respawn target rooms and coordinates belong in the `SCREEPS_RESPAWN_TARGETS` secret,
never repository variables or public workflow logs.

Runtime telemetry and diagnostics treat player-controlled values and exception text as hostile. They
emit bounded opaque references or fixed codes through the `security/redaction` boundary; raw
identities, coordinates, workflow responses, and secret-like strings must not be added to an
observer surface.
