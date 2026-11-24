### Added

- `tryAcquireFileLock(path, timeoutMs?)`, `probeFileLock(path, timeoutMs?)` and the `FileLock` handle: the binding surface for a non-blocking, kernel-backed exclusive lock on a sidecar file. Acquire and probe run off the JS thread, and a time budget (default 2 s, clamped to 1-60000 ms) bounds how long the caller waits; past it they answer `timed_out`. No platform implementation is built yet, so every target reports `unavailable` for now. Nothing uses the lock yet.
