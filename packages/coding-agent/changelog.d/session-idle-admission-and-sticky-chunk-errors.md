### Fixed

- Idle yield deliveries queued behind a failing startup barrier are drained instead of retained forever. Idle admission failures that no later admission can repair (readiness rejection or disposal) now drop their entries and release any owned-completion claims, while genuinely retryable admission failures still keep the queue intact.
- A streaming output chunk error is sticky: a later successful chunk no longer hides an error that already escaped, and a pending buffered tail is flushed or failed as one unit.
