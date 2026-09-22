### Fixed

- `spawn_failed` responses now report a bounded, sanitized cause (including child exit status when available), and Bun `ENOENT` for a missing absolute executable is handled as a normal broker failure instead of crashing the broker.
