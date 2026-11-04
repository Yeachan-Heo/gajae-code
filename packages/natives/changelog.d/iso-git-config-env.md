### Fixed

- Isolation git commands drop `GIT_CONFIG_*` from the child environment, so a repository `.env` cannot set `core.hooksPath` while a task worktree is created.
