### Fixed

- **SDK broker startup**: heartbeat checkpoint retries share one elapsed lock-wait budget inside the bootstrap deadline, leaving time for discovery publication. Startup cancellation interrupts queued or contended waits, and late acquisition/replay cannot write a heartbeat from a cancelled pass.
