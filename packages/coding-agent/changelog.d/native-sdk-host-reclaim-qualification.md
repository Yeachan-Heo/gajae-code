### Fixed

- Refuse stale-lock recovery unless both the recorded and caller host identities are nonempty and equal. Missing-host JSON and legacy lock generations remain protected from local PID absence or reuse.
