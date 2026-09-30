### Fixed

- Reduced macOS idle CPU from the bash shell guardian: the Darwin ancestry poll now reads kernel process identities first and validates only new descendants with `Process.fromPid`, instead of querying every process on each scan. A descendant whose validation fails transiently is retried on the next poll rather than dropped from cleanup.
