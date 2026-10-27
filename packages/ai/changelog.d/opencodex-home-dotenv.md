### Fixed

- OpenCodex model discovery resolves `OPENCODEX_HOME` from the launching shell and user-owned env files, so a project `.env` cannot choose `runtime-port.json`. A rejected live value is removed from the process environment. Later Bun spawns set that name to the trusted directory captured at the first rejection, or to empty when none is trusted, so a later discovery and a child working directory cannot restore an older rejected value.
