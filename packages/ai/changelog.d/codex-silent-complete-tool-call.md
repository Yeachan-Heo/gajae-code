### Fixed

- End a silent Codex WebSocket stream at its idle bound after a completed `todo_write` tool-call start with zero usage.
- Preserve Codex transport errors and eligible SSE recovery when provisional tool arguments parse to null or another non-record value.
