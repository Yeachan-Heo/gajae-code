### Fixed

- Let fresh coordinator-MCP `session.create` requests proceed past unrelated completed metadata-free legacy rows while preserving live and uncertain fences. Exact target-derived terminal legacy create retries can still migrate/replay, but those old rows do not retain a recoverable caller key, so a same-key request for a different target cannot be distinguished from an unrelated key and may start a new create. Key-only legacy create conflicts and non-create target-key conflicts remain protected.
- Scrub TUI/session identity and lifecycle markers from detached broker startup while preserving supported session budget/memory settings, explicit tmux session names, and user tmux configuration.
