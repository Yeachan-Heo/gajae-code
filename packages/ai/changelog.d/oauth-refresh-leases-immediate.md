### Fixed

- Start SQLite auth-storage read-then-write transactions immediately to prevent concurrent OAuth refresh processes from failing with `database is locked`.
- Advance the OAuth lease clock by time spent waiting for the immediate write reservation so busy-timeout waits do not shorten leases.
