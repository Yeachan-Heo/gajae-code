### Fixed

- On macOS, bash shell cleanup now spares a descendant as the shared SDK broker only when its full launch command and kernel-reported executable match gjc's own broker launch. Before this fix, a shell child could forge a broker-shaped command line and a self-written `broker.json`, outlive shell teardown, and pose as the broker to later SDK clients.
