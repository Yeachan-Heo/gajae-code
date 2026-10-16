### Fixed

- Concurrent Slack root requests now wait through the active durable publication lease and retry only after its state changes or expires, avoiding false timeouts while a valid publisher is still working.
