### Added

- `AuthStorageOptions.credentialPreferences` accepts a persisted soft OAuth account preference per provider (`ConfiguredCredentialPreference`: selector plus optional `maxUsedFraction`). The preferred row is moved ahead of balanced/earliest-reset ranking while it is usable, and yields to the normal ranking when it is blocked, no longer stored, or its most-used known usage window has reached `maxUsedFraction`. Runtime `--credential`/`--prefer-credential` selectors and session stickiness take precedence.

### Fixed

- `--prefer-credential` now selects the designated OAuth account when the provider also stores API-key rows. The preferred row was matched by its index in the full credential list against OAuth-only candidate indices, so a mixed pool could move a different OAuth account to the front.
