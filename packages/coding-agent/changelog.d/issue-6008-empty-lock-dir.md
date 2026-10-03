### Fixed

- Empty lock directories (no `info` file) older than the stale timeout are now claimed on Windows (#6008). On Windows, with the no-replace publication in 0.17.x, an empty lock directory cannot be a live holder and can only result from a failed release/removal. After the acquisition budget elapses, such directories are now detected as stale and safely claimed by writing an owner info file, preventing the "held by an unrecognized owner record" error that wedges the agent directory. On POSIX systems, empty directories remain protected as potential legacy directory-lock holders.
