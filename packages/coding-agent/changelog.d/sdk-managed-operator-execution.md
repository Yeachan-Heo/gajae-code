### Added
- Add SDK-managed Bash/Python operator admission, bounded streaming observation, exact execution cancellation and explicit backgroundability outcomes using the existing session executors.

### Fixed
- Renew cached views after native-authorized cwd/transcript moves, retiring raw views and old refs before publication and fencing retryable pending writer settlement without weakening immutable-owner or native cleanup admission guards; retain canonical logical-session cleanup renewal and reject native precommit reentry before nested abort effects.
- Allow execution-owned AbortSignals without changing global Bash/Python abort semantics or cancelling unrelated executions.
