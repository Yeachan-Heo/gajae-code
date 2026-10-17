### Fixed
- Keep SDK broker startup-lock retries inside the original discovery deadline, stop cancelled failed lock attempts before stale-lock cleanup, and preserve retained file-lock transition diagnostics when bounded heartbeat checkpoint acquisition is cancelled.
