### Added

- Gemini reasoning-summary header runaway detection via `GeminiHeaderRunDetector` class with `GEMINI_HEADER_RUNAWAY_THRESHOLD = 64`. This detects when Gemini models emit consecutive reasoning-summary headers without tool calls and can be used to interrupt degenerate reasoning loops (#7915).
