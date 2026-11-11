### Added
- Expose frozen-context side conversations with bounded streamed deltas, exact cancellation and cursor recovery, retaining backend ownership through actual iterator settlement.
- Unify SDK diff observation for staged, unstaged and untracked files with bounded redacted patches and opaque frozen file references.
- Add Broker-owned same-session user revisions using native navigation and prompt delivery while retaining sibling history.

### Fixed
- Separate secure-local grant authority from endpoint credentials, bind authorization to the actual receiving connection, and prevent query/serialization-hook privilege escalation and authorization response observer leaks.
- Preserve ordinary local hosting when private authorization authority cannot initialize, without advertising or admitting sensitive operations.
- Retire session-scoped configuration overrides at identity transitions without overwriting newer foreign writes.
- Fence Python backend admission and late transcript publication to the captured session identity.
