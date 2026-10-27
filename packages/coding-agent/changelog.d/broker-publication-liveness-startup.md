### Fixed

- SDK broker startup fails when the publication-liveness watchdog cannot be armed, instead of staying up without that protection. The failed attempt releases its discovery file and lock. If the watchdog worker dies after startup, the broker exits with `publication-liveness-timeout` rather than keeping the publication unprotected.
