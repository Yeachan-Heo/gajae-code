### Fixed

- Keep Ralplan review-lane budget rejections recoverable within the current run, record generation-scoped recovery, hold auto-handoff while a rejection is unresolved, and make duplicate-write retries idempotent instead of incrementing `stage_n` blindly.
