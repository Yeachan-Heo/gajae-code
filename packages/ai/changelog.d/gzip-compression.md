### Changed

- Anthropic request bodies are now gzip-compressed when sending to first-party `api.anthropic.com` endpoints (matching Claude Code's compression strategy), reducing bandwidth and improving performance for large requests. Compression is transparent and configurable via the fetch wrapper; non-first-party endpoints remain uncompressed. Uncompressed bodies are logged for debugging.

### Added

- New comprehensive test suite (`anthropic-gzip-compression.test.ts`) verifies gzip compression functionality, round-trip integrity, header management, and edge cases.
