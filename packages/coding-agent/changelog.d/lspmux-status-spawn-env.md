### Fixed

- The lspmux status probe passes the project-safe spawn environment, so a repository dotenv cannot deliver `BASH_ENV`, `LD_PRELOAD`, or `NODE_OPTIONS` to that child. A shell value that differs from the project's static declaration is kept. The same string, or a dynamic declaration whose source is ambiguous, is removed.
