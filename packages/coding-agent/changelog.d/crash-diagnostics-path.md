### Fixed

- Crash diagnostics ignore a project dotenv directory override from the directory that loaded the environment, including after a later process directory change and layered dotenv files, refuse a symlink directory, and scrub a bearer token from persisted stderr even when a retained tail has already dropped the marker.
