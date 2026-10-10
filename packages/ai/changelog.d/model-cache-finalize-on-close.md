### Fixed

- Finalize cached SQLite statements when closing the shared model cache so Windows releases its database file handle before temporary roots are removed.
