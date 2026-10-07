### Fixed

- Recover rejected OAuth access tokens before expiry by retrying authentication failures once through the existing refresh lease, adopting peer-rotated broker credentials, and propagating canceled health checks without caching them as credential failures.
- Fence command-key resolutions to their configuration generation so retired lookups cannot return stale credential values.
