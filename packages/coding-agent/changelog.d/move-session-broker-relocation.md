### Fixed

- A committed `move_session` (also `/move` and `session.cwd.move`) now republishes the running session's broker registration at the new cwd before the move returns, so pwd- and repo-scoped session lookups find the session where it now lives instead of at its launch directory.
- A session move committed while an SDK host is still starting is no longer missed: hosts register at the session's committed cwd, and a relocation that fails (including after its event became durable, or against a corrupt index suffix, which is now repaired) is retried until the index converges, so later moves and shutdown release still find the registration.
- The SDK session router reads a moved session's endpoint from its registered state root, so a session stays attachable after its cwd moves away from the launch workspace.
