### Fixed

- Properly handle errors in progress command promise race to prevent suppressed rejections.
- Accept standard ACP inline images larger than the private SDK frame limit without changing image bytes or requiring Paseo-side uploads.
- Keep delayed-echo successor admission cancellable and restage one-shot image references only after a confirmed busy rejection.
- Remove implicitly diverted queued images in both SDK hosts before acknowledging cancellation, and finalize each accepted image prompt at its exact consuming-run terminal or durably confirmed queue removal.
- Suspend image-prompt deadlines while queued, renew joined prompts only on their exact consuming run's progress, and keep real terminal events private while exact deadline settlement remains uncertain.
- Bound retained upload allocations for tiny image fragments as well as payload bytes.
- Renew upload inactivity leases only within an authenticated request batch, preserving earlier completed images during slow multi-image staging while abandoned uploads still expire.
- Validate staged images and their SDK envelope before publishing any user echo; renew the local watchdog only for this request's validated staging progress.
- Advertise image staging only when the host transport supplies authoritative connection liveness and disconnect notifications; keep other SDK controls available to custom transports.
- Enforce the existing two-minute image inactivity lease even when expiry callbacks are delayed.
- Interrupt existing first-turn readiness retry waits on cancellation or teardown without changing retry eligibility, budgets, or provider policies.
- Anchor SDK snapshot storage and cleanup to the accepted absolute root, including relative session paths.
- Reconcile real terminal events without withholding them on deadline uncertainty when no exact run observation was captured.
- Include the Router-owned connection identity when deciding whether CLI-primary image prompts require staging.
- Retire complete uploads after deterministic digest, metadata, or decode failures while keeping capacity-related `busy` failures retryable.
