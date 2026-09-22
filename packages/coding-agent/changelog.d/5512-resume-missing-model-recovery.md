### Fixed

- Resuming a saved session whose complete model chain is no longer registered now uses an authenticated durable profile default as a runtime-only fallback. Saved messages and configured-chain intent remain unchanged; profiles that fail existing catalog, authentication, proxy, alternative-provider, or strict-provider policy still leave resume rolled back (#5512).
