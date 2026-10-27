### Fixed

- Managed `session.spawn` no longer times out on registration: the Broker resolves the actual SDK host (the verified direct child of the pinned managed supervisor, or the headless process itself) before publishing the lifecycle marker, and binds spawn registration to that host's pid/incarnation and the lifecycle request id instead of to the supervisor proof.
