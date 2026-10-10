### Added

- Added `gjc sdk broker run [--agent-dir <dir>]`, a stable foreground broker command for supervisors (systemd, launchd). It never detaches, stops gracefully on SIGTERM or SIGINT and exits with the signal status, exits 1 instead of serving when another live broker already owns the agent directory (never retiring it), and exits 1 if it loses its discovery root while serving.
