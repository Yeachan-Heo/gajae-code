### Fixed

- `gjc doctor --fix --repair service.restart-owned` on the SDK broker now reports a broker refusal, such as `restart_busy` while any session is live, as `blocked` with reason `prepare_refused:<code>` and no side effect. It was previously reported as `uncertain` / `repair_execution_unverified` with `sideEffectStarted: true`. A refused commit now also cancels its prepared reservation instead of leaving new work refused until the lease expires.
