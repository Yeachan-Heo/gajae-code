### Fixed

- Session history database files and WAL sidecars are owner-only on POSIX and Windows, are not opened through a symlink, and a failed first open leaves the database in place.
