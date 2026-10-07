### Fixed

- **Grok CLI version management**: When xAI rejects requests with HTTP 426 "version outdated" errors, learn the minimum required version from the response body and use it for subsequent requests. Falls back to version 1.0.13 if no 426 has been received. Version updates are monotonic: learned versions from 426 responses never downgrade, ensuring that out-of-order responses cannot degrade service.
