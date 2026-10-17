### Added

- Added Claude Haiku 5.5 (`anthropic/claude-haiku-5-5`) to the bundled catalog, taken from a fresh `generate-models` run. Bedrock selectors are not part of this change.
- Claude Haiku 5.5 resolves to adaptive thinking with the documented `low`..`max` effort range and `medium` default on the Anthropic Messages API. Direct requests omit unsupported sampling controls, send an explicit `thinking: { type: "disabled" }` when thinking is Off (including with forced tool choice), request summarized thinking output, and use the documented >100K-token pricing tier. Haiku 4.5 and older keep their existing behavior.
