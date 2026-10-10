### Fixed

- Reusing a detached launch worktree now refuses to check out a new source HEAD when the worktree commit is not an ancestor of that HEAD, so committed work is not silently dropped.
