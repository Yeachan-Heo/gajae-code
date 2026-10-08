### Fixed

- Keep Ralplan review-lane budget rejections recoverable within the current run only through an accepted revision opener; peer-lane retries leave admission pending. Hold auto-handoff while a rejection is unresolved, preserve terminal opener exhaustion, and make duplicate-write retries idempotent instead of incrementing `stage_n` blindly.
