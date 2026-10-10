### Fixed

- Anthropic API-key requests no longer send the Claude Code `X-App: cli` marker, and Anthropic API-key model discovery (`/v1/models`) no longer sends the Claude Code beta list (`claude-code-20250219`, `oauth-2025-04-20`, …). Anthropic classified requests carrying these markers as Claude Code usage, which excluded them from API credit grants such as the Max plan's monthly API credit. OAuth requests are unchanged.
