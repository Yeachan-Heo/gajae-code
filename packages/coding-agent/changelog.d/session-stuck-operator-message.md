### Fixed

- When another process changes a session's transcript, the interactive TUI, startup prompts, ACP clients and SDK clients now show the session's operator message instead of the raw `managed_append_identity_mismatch` code or an opaque "Control operation failed." SDK and ACP responses keep their machine codes.
- `/resume`, `/new` and `/fork` work again in a session whose transcript another process changed. Previously the predecessor flush rethrew the identity mismatch, so every way out of the session failed until the process was restarted.
