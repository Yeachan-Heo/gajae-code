### Fixed

- Session HTML export masks credential-shaped object keys, complete bracketed credential containers, Cookie/Set-Cookie header values, and sensitive JSON-key values, including camelCase fields such as `authToken`, `githubToken`, and `dbPassword`, plus `auth`, `bearer`, `session_key`, `credentials`, `secrets`, and delimiter-separated labels such as `OPENAI_API_KEY` and `api_token`, before base64 encoding while preserving distinct values on key collisions with incremental suffix assignment for large maps and ordinary identifiers such as `session_id`, `source_session_id`, and `native_session_id` as well as `tokensBefore`, `maxTokens`, and `token_budget`.
- String values are scrubbed without an intermediate JSON re-encoding, preserving diagnostic context after quoted credential values.
- Structured HTML exports also mask passphrase fields such as `passphrase`, `sshPassphrase`, and `key_passphrase`.
- Structured HTML exports also recognize multi-segment camelCase credential keys such as `gitHubAccessToken` and `myDatabasePassword`.
