### Fixed

- After a master session switches, its first-request peer snapshot again lists the session it switched away from when another process has resumed that session. The master records the endpoint generation the Broker issued when it registered that session, and treats an owner row with a different generation as a separate host; its own possibly stale row (same generation) and rows without generation evidence stay omitted, as does the current session. Closes #7459.
