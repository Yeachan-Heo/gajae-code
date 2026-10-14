### Added

- Added `ultrafast` as a first-class ServiceTier option, alongside existing tiers (auto, default, flex, scale, priority)
- Support for OpenAI's ultrafast processing tier on OpenAI chat completions and Codex responses APIs
- 6x ultrafast multiplier for API token pricing (per OpenAI's official pricing: $60 input, $300 output for gpt-6-astra)
- Ultrafast service tier now properly resolves and sends to supported models

### Changed

- `ServiceTier` type now includes "ultrafast" as a valid option
- `shouldSendServiceTier()` now includes ultrafast in provider send logic for OpenAI
- OpenAI chat server schema updated to accept "ultrafast" in service_tier field
- Codex included-usage estimates use the official Fast 2.5x and Ultrafast 8x multipliers

### Fixed

- Usage pricing now follows provider-reported effective tiers when available, and gateway responses preserve that tier for downstream clients.

### Notes

- Ultrafast tier is currently available for gpt-6-astra and gpt-6.1-sol. The gpt-5.6-sol model is Fast-only and is not eligible for ultrafast.
- For unsupported models, ultrafast is omitted and provider-default processing is used; no unsupported tier is sent.
