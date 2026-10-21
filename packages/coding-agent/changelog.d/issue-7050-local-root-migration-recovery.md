### Fixed

- Existing managed `local://` roots under temporary storage now migrate into the configured agent profile's persistent root. Interrupted migration resumes by verifying installed entries against the retained source or validated persistent staging when the source is gone, preserving conflicting destination data. Top-level migrated entries publish atomically without replacing files created by concurrent writers. LSP batches flush by stable profile/session identity, and all local-root boundaries use the session's configured agent directory.
