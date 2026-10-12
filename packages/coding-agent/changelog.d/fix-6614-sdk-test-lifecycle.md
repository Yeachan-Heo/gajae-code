### Fixed

- Make SDK terminal-settlement and restart regressions deterministic under asynchronous lifecycle work, restoring test clocks before cleanup and isolating repository fixtures.
- Isolate SDK startup fault injection from unrelated host cleanup and join abandoned-startup cleanup before the next test.
