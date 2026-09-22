### Fixed

- Keep coordinator WAL observations lock-free and read-only. Restrict durable legacy report-ID migration to projection recovery, with cancellable, non-waiting lock acquisition and per-session contention isolation.
