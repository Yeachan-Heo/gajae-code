### Added

- `classifyFallbackTrigger` marks a `rate_limit` trigger with `concurrencyLimited: true` when its typed code says the account is running its maximum number of parallel requests (`session_limit_reached`, `concurrency_limit_exceeded`, `concurrent_request_limit_exceeded`, `too_many_concurrent_requests`), so callers can wait for a free slot instead of failing over.
