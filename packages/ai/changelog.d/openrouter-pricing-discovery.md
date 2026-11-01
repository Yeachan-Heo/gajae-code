### Fixed

- OpenRouter models use the long-context rates OpenRouter publishes in `pricing.overrides` (for example `openai/*` above 272K input tokens), so cost estimates above the threshold are no longer billed at the base rate.
