### Fixed

- **Grok CLI version management**: Bumped the Grok CLI client version sent to xAI from the hardcoded 0.2.33 to 1.0.13. When xAI rejects a request with HTTP 426 "version outdated" and states a minimum version, that version is remembered for the rest of the process and used for subsequent requests.
