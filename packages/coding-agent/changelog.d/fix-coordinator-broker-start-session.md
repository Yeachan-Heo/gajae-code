### Fixed

- Let fresh coordinator-MCP `session.create` requests proceed past unrelated completed metadata-free legacy rows while preserving live and uncertain fences. Terminal target-bound legacy create rows do not retain a recoverable caller key, so their terminal idempotency history expires across this upgrade; key-only legacy create conflicts and non-create target-key conflicts remain protected.
- Scrub TUI/session identity and lifecycle markers from detached broker startup while preserving supported session budget/memory settings, explicit tmux session names, and user tmux configuration.
