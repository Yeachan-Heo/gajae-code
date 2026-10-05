### Added
- Stage ACP inline prompt images larger than the private SDK frame limit through the authenticated SDK upload API without requiring Paseo-side uploads, while preserving original bytes and MIME and retaining the private 256 KiB full-frame limit.

### Fixed
- Preserve cancelled user-image publication barriers across same-session-ID reattachment, including bounded failures during recordless recovery; waiting successors remain locally cancellable without host aborts.
- Validate image staging and the final prompt envelope before publishing the user echo, and renew the local watchdog only for this request's validated staging progress; this guarantee does not cover later prompt admission or model failure.
- Keep upload progress, cancellation, socket handoff and echo-tail fences request-owned. Retry busy admission with fresh upload IDs only after confirmed retirement, and reconcile uncertain acknowledgements through the original client reference without mutation replay.
