### Fixed

- A detached SDK broker left with no client connection, no live session host, and no open spawn authority now exits on its own after `sdk.brokerAbandonedGraceMs` (default 120s) instead of holding its port, its publication, and its lock until the machine reboots, and it removes the registration it still owns.
