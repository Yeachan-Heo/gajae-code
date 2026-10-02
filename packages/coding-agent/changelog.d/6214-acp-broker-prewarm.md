### Fixed

- ACP now starts the broker connection during `initialize` so the first `session/new` skips cold broker discovery; a `session/new` that joins a failed prewarm retries the connection once instead of failing.
- ACP disposal now closes broker adapters that finish connecting during teardown without clobbering newer broker attempts.
