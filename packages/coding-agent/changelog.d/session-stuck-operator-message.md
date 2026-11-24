### Fixed

- When another process changes a session's transcript, the interactive TUI, startup prompts, ACP clients and SDK clients now show the session's operator message instead of the raw `managed_append_identity_mismatch` code or an opaque "Control operation failed." SDK and ACP responses keep their machine codes.
- `/resume`, `/new` and `/fork` work again in a session whose transcript another process changed. Previously the predecessor flush rethrew the identity mismatch, so every way out of the session failed until the process was restarted.
- A session whose transcript another process changed now refuses new prompts, hidden custom-message turns, `--continue`, steering and follow-ups up front, before any hook, tool or model call, with a message that names the recovery: reopen it with `/resume` (or `gjc --resume`), or fork it with `/fork` (or `gjc --fork`). A hidden custom-message turn used to resolve as if it had succeeded, leaving unsaved entries in memory.
- Quitting the TUI from a session whose transcript another process changed no longer crashes with an unhandled `managed_append_identity_mismatch` rejection.
