### Fixed

- SDK broker startup failures now wait for the spawned broker to exit before reading its stderr log, preserving the final diagnostic alongside the typed startup error.
