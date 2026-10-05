### Fixed

- Accept standard ACP inline images larger than the private SDK frame limit without changing image bytes or requiring Paseo-side uploads.
- Keep delayed-echo successor admission cancellable and restage one-shot image references only after a confirmed busy rejection.
- Remove implicitly diverted queued images in both SDK hosts before acknowledging cancellation, and finalize each accepted image prompt at its exact consuming-run terminal or durably confirmed queue removal.
- Suspend image-prompt deadlines while queued, renew joined prompts only on their exact consuming run's progress, and preserve uncertainty when cancellation terminal persistence fails.
- Bound retained upload allocations for tiny image fragments as well as payload bytes.
- Enforce elapsed upload expiry even when cleanup callbacks are delayed, including redemption, in-flight finalization and live-peer batch renewal.
- Preserve cancelled user-image publication barriers across same-session-ID replacement and recordless recovery, retaining failed publication until explicit retirement.
- Cancel the SDK-only ordinary abort requester's admitted preflight snapshot through durable acceptance and before execution starts, without cancelling foreign or later admissions or inventing a durable terminal.
- Renew upload inactivity leases only within an authenticated request batch, preserving earlier completed images during slow multi-image staging while abandoned uploads still expire.
- Validate staged images and their SDK envelope before publishing any user echo; renew the local watchdog only for this request's validated staging progress.
- Authenticate existing managed scope bindings and retained filesystem identities before cold cleanup recovery; never initialize or repair missing storage as a recovery shortcut.
- Re-certify a stale cleanup-completion digest only after independently verified completion through an exact descriptor-backed replacement; refuse destination swaps and replacement failures without replaying transcript deletion.
- Omit explicitly cleared optional owner fields from SDK cleanup replay decoding, matching their persisted JSON shape while retaining strict validation of present owner evidence and refusing replaced scope.
- Retain the originating SDK owner across todo and retry continuations, defer attempt-local failure diagnostics until the actual terminal, and keep real submission settlement behind its exact final publication; preserve acknowledged backoff cancellation without replaying a terminal or clearing committed failures, and keep resolving or rejected cleanup behind the actual durable-terminal recovery owner.
- Publish promoted SDK terminals after their captured handler and same-owner continuation decisions, and hold independent FIFO delivery behind that genuine public boundary without blocking the owning retry or todo continuation.
