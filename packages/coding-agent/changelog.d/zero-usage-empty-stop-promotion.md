### Fixed

- Zero-usage empty stops from context-overflow proxies trigger context promotion and overflow recovery again; only successful empty stops with nonzero usage stay terminal in session-owned turns.
- Total-token-only empty stops (from OpenAI-compatible endpoints returning only `usage.total_tokens`) are now correctly classified as nonzero usage and remain terminal, preventing unnecessary promotion or retry.
