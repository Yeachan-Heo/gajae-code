### Added

- `getApiKey` may return a `ResolvedApiKey` (`{ apiKey, credentialId }`) instead of a bare string. The agent loop forwards `credentialId` to the stream so the resulting assistant message names the stored credential row that served it. A bare string and the static `apiKey` fallback remain unattributed. A turn aborted after streaming began keeps the partial's `credentialId`. `streamProxy` strips `credentialId` from prior assistant messages before posting the context to the proxy server.
