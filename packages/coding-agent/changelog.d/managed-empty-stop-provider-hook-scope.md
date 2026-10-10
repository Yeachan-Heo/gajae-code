### Fixed

- Keep bundled Grok Build request hooks scoped to their provider so unrelated SDK sessions retain replay-safe empty-response fallback without changing accepted lifecycle or transcript boundaries.
- Exercise production SDK lifecycle observers and managed transcript persistence through local HTTP/SSE fixtures, including billed empty stops with a configured fallback model.
- Preserve managed fallback admission for SDK observers without exempting user extensions, and keep billed empty stops out of legacy overflow retries.
- Retain deferred terminal recovery ownership until exact settlement evidence is durably finalized.
