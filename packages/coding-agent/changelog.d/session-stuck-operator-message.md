### Fixed

- When another process changes a session's transcript, the interactive TUI, startup prompts, ACP clients and SDK clients now show the session's operator message instead of the raw `managed_append_identity_mismatch` code or an opaque "Control operation failed." SDK and ACP responses keep their machine codes.
