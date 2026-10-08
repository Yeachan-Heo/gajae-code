### Fixed

- Owned Windows child processes are now tracked through root exit, and teardown retains the owner as `identity_unverified` instead of treating root exit or even a non-empty process snapshot as proof that every descendant stopped. Known pinned targets are still signaled and drained when ancestry is incomplete; complete containment requires atomic Job Object membership at spawn time.
