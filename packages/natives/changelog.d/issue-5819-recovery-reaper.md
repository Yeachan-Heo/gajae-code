### Fixed

- Bounded managed-recovery cleanup now reaps dead-process replacement evidence after a 2-hour grace and removal evidence after 7 days (plus 5 minutes of clock-skew margin). New replacement candidates record boot-scoped publisher identities so a recycled PID cannot pin expired evidence; legacy names without generation tokens remain conservatively protected while their PID is observable and use durable, inode-keyed first-seen markers. `RecoveryFsRoot.recoveryReaperMetrics()` exposes per-sweep and cumulative file/byte counters.
