### Fixed

- **SDK session-host liveness**: re-probe stale heartbeat observations up to four times so transient index-lock contention does not leave live hosts without a heartbeat. Persistent contention still fails closed without renewing stale identity evidence.
- **SDK broker startup**: session heartbeat checkpoint retries share one 15-second monotonic budget, shortened to the remaining bootstrap deadline with publication headroom. Startup cancellation interrupts active lock waits and local queueing, and late acquisitions cannot renew stale session liveness.
