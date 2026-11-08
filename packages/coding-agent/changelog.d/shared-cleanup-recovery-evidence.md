### Fixed

- Validate retained prepared-session locations against native recovery-namespace and file identity, owner-only security, and payload bytes instead of resolving recovery labels relative to child authorities. Missing or changed evidence remains an unresolved cleanup failure; retained files are not reported as physically removed.
- Preserve retryable cleanup for nonmanaged storage backends while keeping uncertain managed removals latched.
