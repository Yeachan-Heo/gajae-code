### Fixed

- Documentation now states the real `sdk.promptDeadlineMs` default. Raising it from 30 to 60 minutes updated the schema but left both READMEs, the Japanese and Korean translations, `docs/sdk.md`, `docs/bot-integration.md`, `docs/hermes-mcp-bridge.md`, `docs/acp-local-development.md`, and the shipped `gjc-sdk-operate` skill telling SDK clients their turn dies after 30 minutes. A new parity test derives the expected figure from the schema default rather than restating it, so the next change to the default fails the build instead of silently misinforming callers (#5637).
