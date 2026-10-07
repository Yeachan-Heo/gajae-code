### Fixed

- **SDK session heartbeat checkpoint** — Enforce the startup deadline through retry attempts. A stale observation triggers a bounded number of fresh-probe retries on contended lock acquisition; each retry now consumes the shared startup deadline instead of acquiring an independent 60-second budget. This prevents the startup watchdog (20 seconds) from being exceeded when multiple retries are needed under legitimate lock contention.
