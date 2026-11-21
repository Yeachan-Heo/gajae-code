### Fixed

- Fixed Codex WebSocket turns sending a delta `input` after a pooled socket reconnected (closed, idle eviction, token refresh, or stale reuse) or when `onPayload` deleted `previous_response_id`, losing accumulated context and causing incomplete or divergent responses (#7921).
