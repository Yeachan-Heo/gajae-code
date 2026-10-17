### Added

- Added the Amazon Bedrock Claude Haiku 5.5 selectors (`anthropic.claude-haiku-5-5` and the `au.`, `eu.`, `global.`, `jp.` and `us.` inference profiles) to the bundled catalog, taken from a fresh `generate-models` run.
- Bedrock Haiku 5.5 resolves to adaptive thinking with the documented `low`..`max` effort range and `medium` default, sends an explicit `thinking: { type: "disabled" }` when thinking is Off (including with forced tool choice), and bills prompts above 100K tokens at a long-context tier.

### Fixed

- `disableReasoning` is now honored on the Bedrock path, so budget-mode Bedrock models keep the caller's requested output cap when reasoning is disabled.
