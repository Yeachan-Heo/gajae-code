### Fixed

- After a master session switches, its first-request peer snapshot again lists the session it switched away from when another process has resumed that session and it is live. The snapshot still omits the current session, and omits the switched-away session while it is not live, since this master stopped its host on the switch. Closes #7459.
