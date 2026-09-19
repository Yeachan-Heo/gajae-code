### Fixed

- Non-persistent direct CLI sessions no longer acquire the shared SDK SessionIndex lock, while persistent sessions continue to publish their liveness registration and surface lock contention.
