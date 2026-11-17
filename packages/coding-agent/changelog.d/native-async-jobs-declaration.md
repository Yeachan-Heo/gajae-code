### Fixed

- Embedders can declare `asyncJobs: "none"` when the host supplies no async job manager, so native Disconnect proves an empty job set instead of blocking on unavailable job evidence.
