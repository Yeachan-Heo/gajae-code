### Fixed

- Existing managed `local://` roots under temporary storage now migrate into the configured agent profile's persistent root. Interrupted migration resumes by verifying installed entries against the retained source, conflicting destination data is preserved, and all local-root boundaries use the session's configured agent directory.
