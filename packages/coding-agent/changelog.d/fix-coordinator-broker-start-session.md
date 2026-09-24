### Fixed

- Let fresh coordinator-MCP `session.create` requests proceed past unrelated completed metadata-free legacy rows while preserving live and uncertain fences. Exact target-derived terminal legacy create retries can still migrate/replay before the key is reused for another target. Old target-bound rows do not retain a recoverable caller key, so a same-key request for a different target may be admitted as fresh; after that request adopts the key, later target changes conflict with the new indexed row. Key-only legacy create conflicts and non-create target-key conflicts remain protected.
- Scrub TUI/session identity and lifecycle markers from detached broker startup while preserving supported session budget/memory settings, explicit tmux session names, and user tmux configuration.
