### Fixed

- A committed `move_session` (also `/move` and `session.cwd.move`) now republishes the running session's broker registration at the new cwd before the move returns, so pwd- and repo-scoped session lookups find the session where it now lives instead of at its launch directory.
- The SDK session router reads a moved session's endpoint from its registered state root, so a session stays attachable after its cwd moves away from the launch workspace.
