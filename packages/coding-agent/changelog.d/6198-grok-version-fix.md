### Fixed

- **Grok CLI version management**: Resolve the Grok CLI version dynamically by fetching the latest release from GitHub (with 24-hour caching). Fallback to 1.0.13 if GitHub is unavailable. When xAI rejects requests with HTTP 426 "version outdated" errors, learn the minimum required version and use it for subsequent requests. Version updates are monotonic: learned versions from 426 responses never downgrade, ensuring that out-of-order responses cannot degrade service.
