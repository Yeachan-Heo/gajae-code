### Added
- Expose frozen-context side conversations with bounded streamed deltas, exact cancellation and cursor recovery, retaining backend ownership through actual iterator settlement.
- Unify SDK diff observation for staged, unstaged and untracked files with bounded redacted patches and opaque frozen file references.
- Add Broker-owned same-session user revisions using native navigation and prompt delivery while retaining sibling history, including validated image edits and answered-revision selection without provider work.
- Expose selected-session HUD usage provenance, live progress, status, tools, branch and owner-scoped non-monitor job counts.

### Fixed
- Separate secure-local grant authority from endpoint credentials, bind authorization to the actual receiving connection, and prevent query/serialization-hook privilege escalation and authorization response observer leaks.
- Preserve ordinary local hosting when private authorization authority cannot initialize, without advertising or admitting sensitive operations.
- Retire session-scoped configuration overrides at identity transitions without overwriting newer foreign writes.
- Fence Python backend admission and late transcript publication to the captured session identity while preserving successful output during identity-preserving maintenance.
- Preserve explicit unknown-durability recovery receipts for indeterminate atomic model/profile writes.
- Keep admitted side turns settling during compaction, redact public side history and streaming output, and retain unknown-effect cleanup admission across controller recreation.
- Refresh stored credential redaction before each side question admission while retaining original and prior-turn secret protection; fail closed on snapshot failure without changing frozen provider history or adding credential lookups to reads.
- Bind activity failure acknowledgements to single-use observed-failure revisions so unseen failures cannot be cleared.
- Remove the effectless direct-operator background operation; expose actual per-execution cancellation capability while retaining real managed-tool `bash.background`.
