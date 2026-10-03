### Fixed

- SDK broker readiness polling now uses the session-index change stamp instead of checkpointing live heartbeats and replaying the full index on every poll.
