### Added

- `gjc sdk diagnostics broker` and the exported `observeExistingBroker` facade now report a real running broker: the broker publishes a startup-fixed diagnostic generation, build snapshot and protocol, and the observation reads the publication only through the approved read-only native lease, opens exactly one client connection with no reconnect attempts, and returns a frozen snapshot with no token, endpoint, path, pid or environment value. An observed result exits 0 and a typed unavailability exits 1.

### Fixed

- Broker observation refuses everything it cannot prove: a publication without the diagnostic capability is `unsupported` (never `absent` or malformed), only the canonical loopback endpoint with an in-range port is accepted, the broker answers only from an already-owned healthy publication, one monotonic budget covers the whole observation so an expired budget never opens a socket and a late answer is discarded, and malformed arguments raise a typed argument error instead of a fabricated observation.
