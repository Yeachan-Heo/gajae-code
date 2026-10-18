### Added

- `AuthStorageOptions.credentialPreferences` accepts an ordered, persisted soft OAuth account preference list per provider (`ConfiguredCredentialPreference[]`: selector plus optional `maxUsedFraction` cap per entry). Selection uses the first listed account that is usable and under its cap; when every listed account is blocked or capped, the unlisted accounts are ranked by balanced/earliest-reset ranking, and capped listed accounts are used only after those. Caps read the windows each provider reports, so they also apply to providers without a ranking strategy. Runtime `--credential`/`--prefer-credential` selectors and session stickiness take precedence. A list whose entries name one stored row twice (for example an email and `account:<id>` for the same login) is ignored as a whole and reported by `AuthStorage.findDuplicateCredentialPreferences()`.

### Fixed

- `--prefer-credential` now selects the designated OAuth account when the provider also stores API-key rows. The preferred row was matched by its index in the full credential list against OAuth-only candidate indices, so a mixed pool could move a different OAuth account to the front.
