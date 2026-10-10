### Added

- Added `gjc sdk broker run [--agent-dir <dir>]`, a stable foreground broker command for supervisors (systemd, launchd). It never detaches, stops gracefully on SIGTERM or SIGINT and exits with the signal status, and exits 1 instead of serving when another broker already owns the agent directory.
