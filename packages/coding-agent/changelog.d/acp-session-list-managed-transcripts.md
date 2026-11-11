### ACP

- ACP `session.list` now includes saved transcripts not in the broker index. Session history now surfaces all saved transcripts, not just those with recent activity in the last 30 days. Managed sessions are merged with broker index sessions, deduplicated by ID, sorted by last modification time, and paged using existing cursor pagination.
