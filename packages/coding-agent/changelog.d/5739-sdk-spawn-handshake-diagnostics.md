### Fixed

- SDK lifecycle spawn failures now report the readiness stage, child status, and a write-bounded sanitized stderr tail through a detached drainer; launch-scoped and remote MCP header credentials remain redacted and the diagnostic provenance is preserved through uncertain cleanup.
