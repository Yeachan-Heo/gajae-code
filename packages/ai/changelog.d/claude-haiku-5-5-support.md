### Added

- Added Claude Haiku 5.5 (`anthropic/claude-haiku-5-5` and the Bedrock `anthropic.claude-haiku-5-5` selectors with `au.`, `eu.`, `global.`, `jp.` and `us.` prefixes) to the bundled catalog, taken from a fresh `generate-models` run.
- Claude Haiku 5.x now resolves to Anthropic adaptive thinking on the Messages API with a `minimal`..`high` effort range and a `medium` default, and to the budget-effort ladder on Bedrock. Haiku 4.5 and older keep their existing behavior.
