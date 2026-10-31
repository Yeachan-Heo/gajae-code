### Added
- Forward a caller-supplied opaque endpoint configuration through native compaction, split summaries, fallback summaries, handoffs and branch maintenance. Omitted standalone scopes retain live trusted routing; no automatic session capture is introduced.

### Fixed
- Preserve the credential type through all local maintenance completions so captured alternate endpoints cannot bypass canonical OpenAI OAuth routing during native fallback or disabled remote compaction.
- Preserve endpoint query routing when constructing OpenAI and Codex native compaction paths.
