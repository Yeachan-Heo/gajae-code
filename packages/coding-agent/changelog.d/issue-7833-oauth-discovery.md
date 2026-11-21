### Fixed

- Discovered models no longer vanish for built-in OAuth providers (google-antigravity, google-gemini-cli) after the OAuth access token expires. The model discovery process now refreshes expired OAuth credentials before attempting discovery, matching the behavior of configured provider discovery. Tokens within the 60-second refresh skew window are automatically refreshed on subsequent API calls by AuthStorage.
