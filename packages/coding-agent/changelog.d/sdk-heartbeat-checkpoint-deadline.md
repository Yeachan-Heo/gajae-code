### Fixed

- SDK session-host liveness re-probes stale heartbeat observations up to four times; persistent contention still fails closed without renewing stale identity evidence.
- SDK heartbeat retries share one 15-second elapsed budget inside the remaining startup deadline. Cancellation fences queued or contended waits and late acquisition/replay before writing.
- SDK broker startup no longer publishes broker discovery while the session-heartbeat checkpoint transaction still holds the session-index lock. The checkpoint now completes its transaction before returning, ensuring the index is available for concurrent reads.
