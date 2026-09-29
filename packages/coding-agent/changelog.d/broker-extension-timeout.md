### Fixed

- Keep optional SDK broker registration off session-start and turn-start extension waits so broker contention cannot trigger the 30-second handler watchdog. Preserve required registration failures, single-flight retries, diagnostics, and shutdown fencing of late publication. Broker recovery still arms only after the startup attempt settles, and a failed optional startup attempt counts toward the recovery backoff.
- Isolate session-runtime fixtures from production broker startup so tests cannot leave detached broker daemons behind after their temporary hosts shut down.
