### Added

- Session history now records which stored credential produced each assistant response. Every assistant message (successful, error, and streaming partials) carries `credentialId`, the opaque row id of the stored credential whose key was sent, so usage can be attributed per account, including when a usage limit moves the turn from one account to another. Messages served by a runtime `--api-key`, a models.yml key, an environment variable, or a fallback resolver have no `credentialId`. Older session files without the field load unchanged.
