# ADR 0014: Security redaction boundary

Status: accepted

## Context

Room names, player names, object identifiers, exception text, and workflow responses can contain
player-controlled or secret-bearing data. Preserving them in operational snapshots is necessary for
the narrow executors that resolve live Screeps objects, but emitting them in telemetry or
diagnostics would make observer surfaces a data-exfiltration path.

## Decision

`security/redaction` is the single pure boundary for rendering untrusted values. It replaces a value
with a deterministic, bounded opaque identifier or a fixed safe code before that value enters
telemetry, a diagnostic, or an error result. The boundary never mutates operational snapshots and
does not own persistent state. If conversion cannot safely read a value, it uses a fixed fallback.

Production architecture rejects direct console output and dynamic evaluation primitives. A later
console reporter consumes only the already-redacted status surface.

## Consequences

- Raw game identities remain available only to typed operational paths that need them to issue a
  Screeps command; observability cannot reconstruct them.
- Fault reporting remains useful through stable domains and codes, without serializing exception
  text or secrets.
- New observability producers must use the boundary; they cannot create an alternate raw-log path.
