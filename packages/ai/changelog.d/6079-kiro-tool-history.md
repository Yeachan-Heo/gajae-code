### Fixed

- Kiro (OAuth CodeWhisperer transport) now replays earlier tool calls as structured `toolUses` and sends each tool result as `{ toolUseId, status, content: [{ text }] }`, linked to the call it answers, instead of serializing calls into assistant text and nesting results. Parallel tool results share one history entry, and image results are marked `[image omitted]` rather than sent empty (#6079).
