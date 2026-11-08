### Fixed

- Preserve prepared-session cleanup phases across retries and report immutable, bounded logical-discard receipts without losing retained namespaces. Distinguish certified payload retirement from Linux detached-but-unscrubbed transcripts; uncertain tree recovery remains blocked. This provides in-process retry safety, not restart recovery or physical namespace reclamation.
