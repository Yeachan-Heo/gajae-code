### Added

- Bundled Claude Fable 5.2 (`claude-fable-5-2`) for the Anthropic API, Amazon Bedrock, and the gateway providers that list it, at Anthropic's published $8/$40 per MTok pricing.

### Fixed

- Claude Fable 5.1+ now advertise auto-only tool choice, so forced `tool_choice` requests downgrade to `auto` instead of returning Anthropic's 400 error.
- Fable requests drop `temperature`, `top_p`, and `top_k`, which every Fable model rejects with a 400 error.
- Direct Anthropic Fable usage prices 1-hour cache writes at twice the input rate instead of the 5-minute rate.
