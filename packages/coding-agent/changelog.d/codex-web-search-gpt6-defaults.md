### Fixed

- Codex web search now selects GPT-6.1 Sol, then GPT-6 Luna, only when advertised by current Codex subscription discovery. Removed legacy GPT-5 defaults and unadvertised fallbacks; unavailable or unmatched discovery fails closed. Explicit model overrides bypass discovery and preserve single-attempt behavior; unsupported-model retries stay limited to advertised defaults.
