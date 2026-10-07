### Fixed

- **SDK session-host liveness**: re-probe stale heartbeat observations up to four times so transient index-lock contention does not leave live hosts without a heartbeat. Persistent contention still fails closed without renewing stale identity evidence.
- **SDK broker startup**: heartbeat checkpoint retries share one 15-second elapsed budget inside the remaining bootstrap deadline, leaving time for discovery publication. Startup cancellation interrupts queued or contended waits, and late acquisition/replay cannot write a heartbeat from a cancelled pass.
