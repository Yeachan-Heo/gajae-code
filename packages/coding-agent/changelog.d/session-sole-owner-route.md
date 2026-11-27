### Fixed

- Starring the current session from the session picker no longer adopts transcript entries that another process appended after this process last wrote them. Previously, the next full rewrite (such as a compaction or a pruning pass) could then drop those entries. The star is now refused with "Another process changed this session's transcript", and the transcript is left unchanged.
