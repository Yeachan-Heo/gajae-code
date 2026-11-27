### Added

- `getApiKey` may return a `ResolvedApiKey` (`{ apiKey, credentialId }`) instead of a bare string. The agent loop forwards `credentialId` to the stream so the resulting assistant message names the stored credential row that served it. A bare string and the static `apiKey` fallback remain unattributed.
