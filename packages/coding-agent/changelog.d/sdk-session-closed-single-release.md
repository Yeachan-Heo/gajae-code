### Fixed

- A session that shuts down while its SDK host is still starting now sends `session_closed` once. Before, the shutdown, the abandoned startup and a deferred re-stop each ran the terminal release at the same time, so clients could get up to three `session_closed` frames.
