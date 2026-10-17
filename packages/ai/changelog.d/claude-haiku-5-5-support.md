### Added

- Added Claude Haiku 5.5 (`anthropic/claude-haiku-5-5` and the Bedrock `anthropic.claude-haiku-5-5` selectors with `au.`, `eu.`, `global.`, `jp.` and `us.` prefixes) to the bundled catalog, taken from a fresh `generate-models` run.
- Claude Haiku 5.5 now resolves to adaptive thinking with the documented `low`..`max` effort range and `medium` default on Anthropic Messages and Bedrock Converse. Direct Anthropic requests omit unsupported sampling controls and use the documented >100K-token pricing tier. Haiku 4.5 and older keep their existing behavior.
