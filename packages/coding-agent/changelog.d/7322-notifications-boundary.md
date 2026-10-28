### Added

- Expose the canonical notification setup service and secret-safe prepared-draft contract through the SDK, shared with the TUI editor.

### Fixed

- Require durable settings and verified identity for active Telegram setup, preserve inactive saves and distinguish persistence from activation, reconciliation and runtime-fencing failures.
- Redact configured cross-provider tokens and fingerprints from health/recovery diagnostics and persisted daemon metadata, including owner IDs, removed endpoint session IDs, retained/debris path lists and recovery command text.

### Changed

- Move notification editor authority out of the terminal controller without adding cross-file atomicity. Marker durability and restore-observer gaps remain explicit degraded outcomes in the embedding guide.
