### Changed

- Bump the bundled Claude Code fingerprint floor from 2.1.281 to 2.1.284.
- Anthropic OAuth requests now sign `claude-cli/<version>` and the billing `cc_version` with the latest published Claude Code release instead of a build-time constant. The version is resolved in the background from Anthropic's `latest` release channel and the npm dist-tag (higher wins), refreshed at most every 6 hours, cached in `~/.gjc/cache/claude-code-version.json`, and never blocks a request or drops below the bundled floor. Set `GJC_CLAUDE_CODE_VERSION=X.Y.Z` to pin it. A stale fingerprint is answered with HTTP 400 `claude_code_version_too_old` on newer models, so this no longer waits for a gjc release to recover.
