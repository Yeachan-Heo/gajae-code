### Fixed

- Sessions without explicit `retry.*` settings now retry a content-free "socket connection was closed unexpectedly" (`ECONNRESET`) failure when the attempt is replay-safe, bounded by `retry.maxRetries`. Previously the bare-default gate only admitted stream-timeout watchdog errors, so a transient connection reset before any response ended the turn even though it was classified as transient.
