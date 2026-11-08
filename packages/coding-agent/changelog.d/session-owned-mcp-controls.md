### Added

- Sessions own their MCP control admission: a session can connect, disconnect and reconnect its own MCP servers while `/new` or a same-path reload restores them, and an in-flight restore is retired with its owner instead of leaking into the successor.

### Fixed

- Disposing during a `/new` MCP restore no longer wedges teardown: the restore is fenced to the predecessor identity, its connector is disconnected, and the successor's first turn joins the restored tools instead of the switch blocking on a physical reconnect.
