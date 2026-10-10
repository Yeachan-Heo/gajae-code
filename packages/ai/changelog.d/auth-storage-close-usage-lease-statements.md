### Fixed

- Finalize all outstanding SQLite auth statements on close, including usage-fetch leases, so Windows releases database file handles immediately.
