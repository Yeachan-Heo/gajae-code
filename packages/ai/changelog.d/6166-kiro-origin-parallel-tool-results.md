### Fixed

- Kiro (OAuth CodeWhisperer transport) now sets `userInputMessage.origin: AI_EDITOR`. Without it the service ignored `modelId` and answered every request with `auto`, so selecting a specific Kiro model had no effect.
- Kiro (OAuth CodeWhisperer transport) now sends every trailing result of a parallel tool batch in `currentMessage`. The earlier results were left as a separate history entry, so the turn after two or more parallel tool calls failed with HTTP 400 `TOOL_USE_RESULT_MISMATCH`.
