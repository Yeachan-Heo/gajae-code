### Added

- Added opt-in native managed task DAGs through authenticated Broker `task.dag` operations, with private durable domain state, resource reservations, native launch and seed fencing, recovery, shared-runner verification, and byte-bound predecessor invalidation. This coordinates enrolled managed tasks only, not arbitrary external processes.

### Fixed

- Hardened enrollment recovery, cross-root idempotency, cancellation, and verification so interrupted or uncertain managed task lifetimes remain fail-closed.
- Bound owner validation subprocesses to owner shutdown and rejected private durable publication beneath unsafe roots.
- Serialized owner submission, recovery, observation, and finalization against retirement so lifecycle writes and receipts cannot outlive owner authority.
