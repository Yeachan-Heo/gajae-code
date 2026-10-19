### Fixed

- Expose Windows `access_denied` in canonical-directory identity and owner-only security result types so callers represent ACL-denied operations and classify them accurately (issue #6618).
- Add handle-derived exact unlink for empty staged files whose host-side identity capture fails, preserving replacement files installed at the original pathname.
