### Fixed

- A second in-process root session no longer replaces the first session's `0-Main` registry entry, so IRC addressed to that id stays on the session that claimed it. A `memory://` read with the caller's cwd uses that session's memory root.
