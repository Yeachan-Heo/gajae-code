### Fixed

- SDK lifecycle spawn failures now report the readiness stage, child status, and a bounded sanitized stderr tail without attaching a parent-owned pipe to detached hosts; launch-scoped credentials remain redacted and the diagnostic provenance is preserved through uncertain cleanup.
