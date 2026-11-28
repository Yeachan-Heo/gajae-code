### Fixed

- Anthropic `429 credits_required` ("Usage credits are required for this model.") is now treated as account-level usage exhaustion: it is no longer retried on the same account and triggers rotation to another stored credential, including during auto-compaction.
