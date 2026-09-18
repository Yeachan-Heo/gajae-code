### Added

- Added opt-in native managed task DAGs through authenticated Broker `task.dag` operations, with private durable domain state, resource reservations, native launch and seed fencing, recovery, shared-runner verification, and byte-bound predecessor invalidation. This coordinates enrolled managed tasks only, not arbitrary external processes.
