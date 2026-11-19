### Fixed

- Publish model presets through managed shared-session admission after ordinary messages or title changes, preserving sibling branches and the configured fallback chain, effective thinking, and resume default (#7823).
- Keep known refused preset publications from attempting an unneeded rollback; preserve publication receipts and close the session when a shared preset write has an uncertain outcome or cannot be applied after commit (#7823).
