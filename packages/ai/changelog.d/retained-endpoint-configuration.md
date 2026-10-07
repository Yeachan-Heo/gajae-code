### Added
- Accept an opaque captured endpoint configuration in generic and direct builtin streaming. OpenAI, Anthropic/Foundry, Azure, and Vertex request construction retains captured routing values and authoritative absence while API keys, OAuth tokens, and ADC credentials remain shared.
- Validate explicit handles before provider dispatch, preserve explicit provider-option precedence and canonical OAuth origins, and retain caller-provided fetch transports through simple option mapping.

### Changed
- Google Vertex preflight now reads `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` from captured endpoint configuration instead of the process environment. This tightens the trust boundary: project and location are no longer merged from the caller's `.env`.

### Fixed
- Align OpenAI remote compaction endpoint resolution with provider implementations: both now use URL parsing to identify default OpenAI base URLs, ignoring port differences. This ensures consistent routing when a proxy is captured and a custom-port model URL is configured (e.g., `https://api.openai.com:8443/v1`).
- Classify model URLs before compaction path normalization so explicit slash-suffixed routes are not silently redirected to a captured proxy.
