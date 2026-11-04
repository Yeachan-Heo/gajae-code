### Fixed

- A second in-process root session no longer replaces the first session's `0-Main` registry entry, so IRC addressed to that id stays on the session that claimed it. Search, find, and bash resolve `memory://` with the calling session's settings instead of the process agent directory.
