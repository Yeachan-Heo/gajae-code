### Changed

- OpenAI-completions first-event timeouts now report elapsed time, request size, a coarse `canonical`/`custom` endpoint class, the configured timeout, and the override knobs (`retry.streamFirstEventTimeoutMs`, `PI_STREAM_FIRST_EVENT_TIMEOUT_MS`), both in the error message and as typed transport-failure facts. Endpoint URLs, hosts, and credentials are never included.
