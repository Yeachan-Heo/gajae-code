### Added

- Added `ultrafast` as a first-class ServiceTier option, alongside existing tiers (auto, default, flex, scale, priority)
- Support for OpenAI's ultrafast processing tier on OpenAI chat completions and Codex responses APIs
- 6x cost multiplier for ultrafast tier pricing (per OpenAI's official pricing: $60 input, $300 output for gpt-6-astra)
- Ultrafast service tier now properly resolves and sends to supported models

### Changed

- `ServiceTier` type now includes "ultrafast" as a valid option
- `shouldSendServiceTier()` now includes ultrafast in provider send logic for OpenAI
- OpenAI chat server schema updated to accept "ultrafast" in service_tier field
- Codex service tier cost multiplier function now handles ultrafast 6x multiplier

### Notes

Ultrafast tier is currently available for:
- gpt-6-astra (broadly available)
- gpt-6.1-sol (broadly available)  
- gpt-5.6-sol (preview)

The tier is not sent to unsupported models; requests fail-closed with no silent fallback.
