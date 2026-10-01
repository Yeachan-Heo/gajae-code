### Fixed

- **Grok CLI version management**: Bumped Grok CLI client version from hardcoded 0.2.33 to 1.0.13. Added automatic version learning from HTTP 426 "version outdated" errors returned by xAI. When xAI returns a 426 response with a minimum version requirement, the version cache is automatically updated for subsequent requests. Added failure backoff protection that preserves known working versions during transient errors instead of downgrading to fallback.
- **Grok CLI tests**: Fixed tests to mock network calls properly and validate cached version behavior, error handling, and version preservation during failure backoff.
