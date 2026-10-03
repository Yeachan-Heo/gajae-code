### Added
- Stage ACP inline prompt images through the authenticated SDK upload API while preserving original bytes and MIME and retaining the private 256 KiB full-frame limit.

### Fixed
- Validate image staging and the final prompt envelope before publishing the user echo; this guarantee does not cover later prompt admission or model failure.
- Keep upload progress, cancellation, socket handoff and echo-tail fences request-owned. Retry busy admission with fresh upload IDs only after confirmed retirement, and reconcile uncertain acknowledgements through the original client reference without mutation replay.
