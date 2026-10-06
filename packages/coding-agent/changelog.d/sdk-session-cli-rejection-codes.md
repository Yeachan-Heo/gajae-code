### Fixed

- `gjc sdk session send` to a session that is running a turn now reports `busy` with `outcomeCertainty: "not-applied"` and points at `turn.steer`, instead of `operation_failed` with an unknown outcome and a status lookup that can only answer `unknown`.
- `gjc sdk session raw control|query|global` with an unknown `--op` id, and `gjc sdk session list` with a Git-only scope outside a repository, now fail as usage errors (exit 2, not applied) with fixed diagnostics (`sdk_unknown_operation`, `sdk_scope_requires_repository`) instead of `operation_failed`.
