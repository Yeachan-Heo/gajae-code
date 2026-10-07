### Fixed

- **SDK broker startup**: session heartbeat checkpoint retries now respect the startup deadline to prevent exceeding the bootstrap watchdog fence when lock contention is sustained across multiple probe attempts.
