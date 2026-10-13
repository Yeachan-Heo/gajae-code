### Fixed

- Switching the model cache to a different database path now fully releases the previous database. A migration query left an unfinalized prepared statement, so closing the old connection left it open in the background; it kept the database locked and, on Windows, blocked deleting its directory.
