# Codex Responses: Fix event loop starvation with long streaming responses

### Fixed

- Codex provider no longer buffers delta events, which was causing the event loop to block for minutes during long streaming responses (#8127)
- JSON argument parsing is now deferred to avoid O(n²) behavior when processing many streaming deltas
- Delta events (text_delta, toolcall_delta) flow immediately without buffering, allowing the event loop to yield and process concurrent work
- Completion checks for JSON parsing are now done only on boundaries (when closing braces are seen or every 1KB), not on every delta
