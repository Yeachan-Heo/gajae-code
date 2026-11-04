### Fixed

- Concrete model and mixed-role selections now commit profile ownership, its default projection, and role assignments atomically before publishing the selection. Stale selections and rollback cannot overwrite a newer owner; publication failures retain the committed owner and close the requesting session.
- SDK `config.patch` rejects independent changes to `modelProfile.default`, preventing it from diverging from the internal ownership record. Use explicit profile-selection controls instead.
