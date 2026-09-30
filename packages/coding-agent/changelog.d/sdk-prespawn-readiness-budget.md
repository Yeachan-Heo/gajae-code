### Fixed

- Give broker-admitted lifecycle launches without a worktree a fresh child readiness budget after bounded pre-spawn bookkeeping, while preserving caller-supplied exact deadlines.
- Bound broker-derived non-worktree pre-spawn preparation by the unused admission window (10s without queueing at default readiness), so fresh readiness still finishes inside the unchanged caller deadline.
