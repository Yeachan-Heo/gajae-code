### Fixed

- **Grok CLI version management**: Bumped Grok CLI client version from hardcoded 0.2.33 to 1.0.13. Added background version fetching from GitHub releases with caching (24-hour TTL) and failure caching to prevent retry storms when the GitHub API is unavailable. The version header is always available synchronously (fallback on first call), with best-effort background updates for subsequent requests.
- **Grok CLI tests**: Fixed tests to mock network calls to GitHub instead of making real HTTP requests. Tests now properly validate cached version behavior and failure handling.
