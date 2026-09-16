### Fixed

- Stop dead-ending explicit "use worktree" requests when `task.isolation.mode` is `none` (the shipped default). The routing guidance is now rendered from the session's actual isolation state: with isolation off the agent creates a dedicated `git worktree` instead of refusing over the `isolated` parameter the task schema does not advertise.
