### Changed

- With `session.ownership.mode: enforce`, an interactive session whose process holds the session alone now writes it directly. It no longer goes through the shared-publication path that exists for two terminals writing one session. After the first message, star, tree summary (branch with summary), Move Session and `/drop` work again; previously they were refused as "Shared session mutation requires transaction admission". In `observe` and `off`, and when gjc cannot take the session's lock (for example on Windows, or after a lock timeout), sessions keep the shared path and its refusals.
- `/drop` and Move Session refuse a session that another process changed after this process last wrote it, with "Another process changed this session's transcript". The other process could be one running with session ownership `off`, or an older gjc. The refusal comes before anything is switched, moved or deleted, and the transcript is kept.

### Fixed

- Starring the current session from the session picker no longer adopts transcript entries that another process appended after this process last wrote them. Previously, the next full rewrite (such as a compaction or a pruning pass) could then drop those entries. The star is now refused with "Another process changed this session's transcript", and the transcript is left unchanged.
