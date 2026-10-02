### Fixed

- Codex SSE progress classification reads each event's `delta` once, so the idle-watchdog classifier added in #6226 can no longer observe a different value than the stream handler assembles.
