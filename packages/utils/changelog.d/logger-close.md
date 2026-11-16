### Added

- `logger.close()` flushes every record written so far and closes the rotating log file, resolving once the file stream finishes (bounded by a 2-second deadline). A later log call opens the transports again. The shared test preload calls it before removing each test file's isolated `gjc-test-logs-*` directory, so a test that logs no longer leaves that directory behind in the OS temp root.
