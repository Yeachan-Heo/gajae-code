### Fixed

- Google Cloud Code Assist streams (`google-gemini-cli` and `google-antigravity`, e.g. `gemini-4-argon`) now use a 300-second idle window instead of the shared 120-second default. Cloud Code Assist sends a `functionCall` part only after the whole call is generated, so a large `bash`/`write` tool call left minutes of silence after the preceding text and the turn failed with `Provider stream stalled while waiting for the next event`, discarding the streamed output (#7474). `PI_STREAM_IDLE_TIMEOUT_MS` and an explicit `streamIdleTimeoutMs` still take precedence.
