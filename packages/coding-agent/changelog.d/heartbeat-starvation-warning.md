### Fixed

- The SDK broker now logs a warning when a heartbeat checkpoint writes nothing because every attempt saw a stale observation, instead of returning silently while running sessions age out to `live: false` (#7151).
