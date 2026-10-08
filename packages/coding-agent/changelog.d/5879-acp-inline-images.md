### Fixed

- Accept standard ACP inline images larger than the private SDK frame limit without changing image bytes or requiring Paseo-side uploads.
- Keep delayed-echo successor admission cancellable and restage one-shot image references only after a confirmed busy rejection.
- Remove implicitly diverted queued images in both SDK hosts before acknowledging cancellation, and finalize each accepted image prompt at its exact consuming-run terminal or durably confirmed queue removal.
- Suspend image-prompt deadlines while queued, renew joined prompts only on their exact consuming run's progress, and keep real terminal events private while exact deadline settlement remains uncertain.
- Hold a turn's terminal event when a scheduled todo reminder continuation still owns the predecessor lifecycle, including synchronous continuation failure.
- Bound retained upload allocations for tiny image fragments as well as payload bytes.
- Renew upload inactivity leases only within an authenticated request batch, preserving earlier completed images during slow multi-image staging while abandoned uploads still expire.
- Validate staged images and their SDK envelope before publishing any user echo; renew the local watchdog only for this request's validated staging progress.
