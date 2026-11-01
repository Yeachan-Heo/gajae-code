### Fixed

- Idle yield deliveries queued behind a failing startup barrier are drained instead of retained forever. Idle admission failures that no later admission can repair (readiness rejection or disposal) now drop their entries and release any owned-completion claims, while genuinely retryable admission failures still keep the queue intact.
- A profile switch superseded mid-activation no longer records its transient DEFAULT model in the usage order, so the model the user picked while the switch was in flight stays the MRU head.
