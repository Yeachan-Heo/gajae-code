### Fixed

- Concrete model and mixed-role selections now commit profile ownership, its default projection, and role assignments atomically before publishing the selection. Stale selections and rollback cannot overwrite a newer owner; publication failures retain the committed owner and close the requesting session.
- Role cycling preserves configured DEFAULT selectors and fallback chains. Permanent model selections commit suspended provider-session scopes only after successful publication, preventing stale temporary scopes from restoring an older choice.
- Session disposal drains its already-authorized default selection, including its ownership commit, while rejecting new ingress and still protecting concurrent ownership winners.
- SDK `config.patch` rejects independent changes to `modelProfile.default`, preventing it from diverging from the internal ownership record. Use explicit profile-selection controls instead.
