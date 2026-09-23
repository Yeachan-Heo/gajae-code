### Fixed

- Dead-owner SDK session lock acquisition failures now identify guarded-removal refusals and provide a platform-specific manual cleanup command when the same dead owner still holds the lock at exhaustion; broker startup also preserves its bounded discovery recovery when that startup lock disappears before the failure marker is examined (#5827).
