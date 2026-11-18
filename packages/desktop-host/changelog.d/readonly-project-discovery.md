### Changed
- Keep discovered conversations read-only until explicit native SDK admission; selecting history observes exact persisted checkpoints without creating a competing owner.
- Refresh project inventory additively on bootstrap and explicit requests, with per-project throttling, single-flight scans and close/reopen epoch fences.
