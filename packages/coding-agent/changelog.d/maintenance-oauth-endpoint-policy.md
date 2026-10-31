### Fixed

- Preserve the selected credential type in session handoff and branch summarization so OpenAI OAuth bearer tokens remain on the canonical endpoint rather than an API-key proxy.
- Resolve maintenance credential types from effective registry-owned authentication, including runtime and config API-key overrides, instead of stale stored-session history.
