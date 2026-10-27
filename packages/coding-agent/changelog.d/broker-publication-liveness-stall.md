### Fixed

- A stalled discovery publication fsync/rename no longer keeps an SDK broker alive past its liveness deadline (`publication-liveness-timeout`, `max(60s, heartbeat TTL × 4)`). When that write blocks the JS thread, `gjc sdk broker run` is SIGKILLed (signal status 137, not exit 1), including when stderr cannot accept the diagnostic. While the event loop still runs, it still exits 1.
