### Fixed

- Apply the shared stream idle timeout to Codex WebSocket responses when no WebSocket-specific timeout is configured, so a stalled preferred transport surfaces an error within the expected idle window.
