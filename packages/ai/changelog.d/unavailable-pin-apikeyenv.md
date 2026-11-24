### Fixed

- `AuthStorage.getApiKey` now checks a scope's unavailable hard-pin marker before an `apiKeyEnv` config override consults the stored `api_key` pool, matching `peekApiKey`. A provider whose pinned account is unavailable can no longer be answered by a different stored account; runtime and literal config keys still outrank the marker (#8012).
