### Fixed

- Recover rejected OAuth access tokens before expiry by retrying authentication failures once through the existing refresh lease, adopting peer-rotated broker credentials, and propagating canceled health checks without caching them as credential failures.
- Preserve results for callers already awaiting command-backed credentials after configuration replacement without publishing stale cache state.
