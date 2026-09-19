### Added

- Custom-provider setup now starts OpenAI-compatible model discovery as soon as credentials are supplied, preserves manual fallback, and prevents late previews from changing another wizard step's selection. Leaving confirmation to revise inputs cancels an in-flight submission before opening the editor. Cancellation is checked through the configuration commit boundary, and failed credential restoration is reported rather than silently discarded. No-model recovery guidance exposes both manual model IDs and discovery (#5387).
