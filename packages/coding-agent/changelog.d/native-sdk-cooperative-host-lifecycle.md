### Fixed

- Reserve mixed-provider startup before its first asynchronous identity preflight. Concurrent starts join the same flight; shutdown cancels that exact flight before resource construction, preventing an untracked host or post-shutdown endpoint publication.
- Settle joined startup failures only after actual cleanup with the final cleanup-aware result, retaining failed-release retry authority and preventing secondary cleanup errors from leaking as premature extension failures.

- Establish factory cleanup ownership before CLI endpoint admission; retire only an exact factory-minted cooperative membership after proven closed, debt-free teardown, preserving pre-existing and uncertain authority.
- Admit unowned real persistent writers before notification/SDK endpoint publication and revalidate already-owned writers without issuing a redundant publication. Structural read-only contexts and ephemeral managers remain outside transcript ownership.
- Wait for canonical simultaneous PTY user records, not earlier workflow preview strings, while retaining exact original ID, immediate-parent, branching and process-exit assertions.
- Authenticate every indexed and actual endpoint process against one exact live local cooperative group, preserving ordinary shared-host generation changes and transport withdrawal without a PID-only exception or native admission bypass.
- Admit interactive CLI ownership before endpoint-producing extensions, preserve descriptor-verified legacy linear loading without native graph authority, and retain exact single-marker shared bootstrap publication.
