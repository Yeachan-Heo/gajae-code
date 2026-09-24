### Changed

- Bump the spoofed Claude Code version from 2.1.280 to 2.1.281 and Gemini CLI version from 0.60.0 to 0.61.0. Anthropic gates newer models behind a minimum client version, so a stale `claude-cli` fingerprint can return HTTP 400 for an otherwise reachable model; the Gemini CLI fingerprint drifts the same way.
