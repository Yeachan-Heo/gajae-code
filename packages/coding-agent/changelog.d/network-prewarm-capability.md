### Fixed

- `startup.networkPrewarm` no longer reports itself enabled while doing nothing. Bun 1.4.0's `fetch.preconnect()` throws `Invalid port` for provider URLs on their default HTTPS port, and the throw was repeated at debug level while the setting remained enabled. The first real model-host preconnect now doubles as the capability probe: failure retires prewarm for the process with one warning and restores the unprewarmed first-request latency baseline.
