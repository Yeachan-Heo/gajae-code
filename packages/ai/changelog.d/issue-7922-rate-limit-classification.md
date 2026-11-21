### Fixed

- Rate limit errors with HTTP 402 status (payment required) combined with overflow-like prose (e.g., "too many tokens") are no longer misclassified as context overflow. Both 402 and 429 status codes now prevent overflow classification regardless of error message text, keeping these non-overflow failures fail-fast (#7922).
