### Added
- Accept an opaque captured endpoint configuration in generic and direct builtin streaming. OpenAI, Anthropic/Foundry, Azure, and Vertex request construction retains captured routing values and authoritative absence while API keys, OAuth tokens, and ADC credentials remain shared.
- Validate explicit handles before provider dispatch, preserve explicit provider-option precedence and canonical OAuth origins, and retain caller-provided fetch transports through simple option mapping.

### Fixed
- Align OpenAI remote compaction endpoint resolution with provider implementations: both now use URL parsing to identify default OpenAI base URLs, ignoring port differences. This ensures consistent routing when a proxy is captured and a custom-port model URL is configured (e.g., `https://api.openai.com:8443/v1`).
