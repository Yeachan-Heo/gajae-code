### Added
- Add SDK-managed Bash/Python operator admission, bounded streaming observation, exact execution cancellation and explicit backgroundability outcomes using the existing session executors.

### Fixed
- Allow execution-owned AbortSignals without changing global Bash/Python abort semantics or cancelling unrelated executions.
