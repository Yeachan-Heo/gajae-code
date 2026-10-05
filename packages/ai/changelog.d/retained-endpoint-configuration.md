### Added
- Accept an opaque captured endpoint configuration in generic and direct builtin streaming. OpenAI, Anthropic/Foundry, Azure, and Vertex request construction retains captured routing values and authoritative absence while API keys, OAuth tokens, and ADC credentials remain shared.
- Validate explicit handles before provider dispatch, preserve explicit provider-option precedence and canonical OAuth origins, and retain caller-provided fetch transports through simple option mapping.
