### Added

- Bundled Claude Fable 5.2 (`claude-fable-5-2`) for the Anthropic API, Amazon Bedrock (base, `us.`, and `global.` profiles), and the gateway providers that list it, at Anthropic's published $8/$40 per MTok pricing.

### Fixed

- Claude Fable 5.1+ now advertise auto-only tool choice, so forced `tool_choice` requests downgrade to `auto` instead of returning Anthropic's 400 error.
- Fable requests drop `temperature`, `top_p`, and `top_k`, which every Fable model rejects with a 400 error. Bedrock Converse requests for Fable, Opus 4.7+, and Haiku 5+ also omit `temperature` and `topP` from `inferenceConfig`.
- Direct Anthropic Fable usage prices 1-hour cache writes at twice the input rate instead of the 5-minute rate.
- Amazon Bedrock no longer advertises `eu.anthropic.claude-fable-5-1`; AWS lists no EU Geo inference profile for Fable 5.1/5.2, so EU callers use the `global.` profile.
