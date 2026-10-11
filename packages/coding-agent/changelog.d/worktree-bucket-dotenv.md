### Fixed

- A project `.env` declaration of `GJC_WORKTREE_DIR`, including a dynamic one, no longer selects the launch worktree bucket; the default `{repo}/.worktrees` path is used instead, while an operator value the project does not declare is kept.
