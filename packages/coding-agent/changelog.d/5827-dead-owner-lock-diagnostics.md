### Fixed

- Dead-owner SDK session lock acquisition failures now identify guarded-removal refusals and provide a platform-specific manual cleanup command when the same dead owner still holds the lock at exhaustion (#5827).
