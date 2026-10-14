### Added

- Add Gemini 4 Argon (`gemini-4-argon`) and send `thinkingLevel` (low/medium/high) for Gemini 4 models instead of falling back to `thinkingBudget`.

### Fixed

- Normalize negative and non-finite model catalog prices to zero so bundled usage estimates cannot become negative.
