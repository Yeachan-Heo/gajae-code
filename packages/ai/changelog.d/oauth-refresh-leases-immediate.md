### Fixed

- Start SQLite auth-storage read-then-write transactions immediately to prevent concurrent OAuth refresh processes from failing with `database is locked`.
