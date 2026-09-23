### Added
- Add opt-in Kev/Jev decisions for fresh subagent tiers with shadow and routing modes, bounded requests, trusted credentials, and fail-open routing that leaves the main session unchanged.
- Add explicit owned local Kev installation and lifecycle commands, plus private local execution observations and read-only JSONL export with late shadow results.
- Stop the owned local Kev server through an authenticated, process-bound supervisor socket instead of signaling a recorded pid, so a pid reused between the ownership check and the stop can never be signaled.
- Carry local Kev inference over the owned supervisor's authenticated socket instead of a configurable loopback URL, so task text can never reach an unrelated process that holds the port; `task.decision.kevEndpoint` is removed.
- Bound opted-in decision collection with `task.decision.collectionRetentionDays` and `task.decision.collectionMaxEvents`, and stream the export a page at a time.
- Selecting `task.decision.provider jev` transmits the subagent role and its raw assignment text to Typesafe's remote endpoint; this is an explicit opt-in transfer of task content to a third party, is billable, and never happens by fallback from the local provider.
- Refs #5842: this is intentionally a partial, tier-selection-only step. Only the tier `choice` in `shadow` or `routing` is implemented; `enforce`, noul delegation, and advisory hint modes remain unavailable pending in-domain evaluation and a separate scope decision.
