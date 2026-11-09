### Added

- Add `session.close` with `ifIdle: true` and `gjc sdk session close --if-idle` to retire idle hosts under the runtime admission fence. Busy hosts remain usable and the same idempotency key can be retried (#7540).

### Fixed

- Preserve public `busy` and `not_found` codes. Report definite no-effect certainty for busy and proven unindexed ordinary-close refusals, not for generic lifecycle `not_found` failures (#7540).
- Count side-turn credential/provider work and foreground bash as busy, fence background side turns, and finish accepted close even when response delivery fails. Reconcile already-exited managed spawn owners only with exact host-exit proof (#7540).
