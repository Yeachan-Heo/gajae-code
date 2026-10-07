### Fixed

- Windows session management now derives endpoint identity from file system paths instead of logical paths, preserving endpoint stability across path aliases (symlinks, relative segments, case variations). This ensures session recovery and async job coordination work correctly regardless of how the session file is referenced.

