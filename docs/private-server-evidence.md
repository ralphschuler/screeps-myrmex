# Private-server evidence contract

Issue [#143](https://github.com/ralphschuler/screeps-myrmex/issues/143) defines a scripts-only,
versioned evidence contract for the private-server lifecycle from
[issue #142](https://github.com/ralphschuler/screeps-myrmex/issues/142). Production runtime code
does not import the contract.

## Manifest and artifact

`definePrivateServerManifest` accepts a fixed v1 manifest: a safe scenario/build/seed identifier,
bounded tick deadline, one declared fault-injection kind, and up to 32 uniquely named numeric
assertion ranges. Unknown fields, unsafe values, duplicate assertion IDs, non-finite numbers, and
out-of-range tick budgets are rejected before execution.

`createPrivateServerEvidence` emits canonical JSON containing the normalized manifest, fixed cleanup
and failure codes, and SHA-256 summaries of capped outcomes, state, and logs. Records are sorted by
their digest, object keys are canonicalized, and the final artifact has its own SHA-256 digest. This
makes equivalent reordered inputs byte-equivalent without retaining raw game state.

| Retained surface                 |                              Cap | Privacy rule                                                                                    |
| -------------------------------- | -------------------------------: | ----------------------------------------------------------------------------------------------- |
| Assertions/outcome/state records |                          32 each | SHA-256 summary only                                                                            |
| Logs                             | 64 records, 512 UTF-8 bytes each | control characters, room coordinates, and key-value secrets are sanitized; SHA-256 summary only |
| Entire evidence artifact         |               65,536 UTF-8 bytes | over-cap input fails the scenario                                                               |

The ignored `.myrmex-private-server/` directory is transient. Launcher logs, database files, Memory,
exception stacks, URLs, credentials, and live-room data are never accepted as artifacts. Cleanup
failure is explicit evidence failure rather than a successful scenario.

## Comparison and sources

V1 has no admitted engine-nondeterministic field: identical declared inputs must produce exactly the
same artifact. A later version may add a named comparison projection for documented engine
variation; it must not silently weaken the v1 digest.

The contract follows the standalone server's documented multi-process launcher and CLI boundaries in
the [official Screeps server repository](https://github.com/screeps/screeps), the official
[Screeps API](https://docs.screeps.com/api/), the official
[game-loop documentation](https://docs.screeps.com/game-loop.html), and the
[Screeps Wiki private-server reference](https://wiki.screepspl.us/Private_Servers/). World
manipulation and exact-bundle scenarios remain owned by issue #144.

The executable matrix and its clean-checkout commands are documented in
[private-server-scenarios.md](private-server-scenarios.md). Live artifact hashes belong in issue or
pull-request evidence, never in the repository.
