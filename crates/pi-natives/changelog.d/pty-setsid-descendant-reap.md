### Fixed

- PTY cancel and timeout now reap setsid descendants that double-fork out of the process group, including descendants adopted by a Linux init or child subreaper.
