### Fixed

- Make SDK terminal-settlement and restart regressions deterministic under asynchronous lifecycle work, restoring test clocks before cleanup and isolating repository fixtures.
- Isolate SDK startup fault injection from unrelated host cleanup and join abandoned-startup cleanup before the next test.
- Synchronize startup-continuation cancellation with actual provider admission instead of scheduler-dependent polling.
- Scope ACP progress-test prompt failures to their owning invocation so background reverse-provider registration remains available.
- Keep ACP replay regressions strict about request identity and absolute deadlines while accounting for time already spent from the caller budget.
