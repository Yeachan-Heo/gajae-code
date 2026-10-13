### Fixed

- A gitignored `.worktrees` symlink that points outside the repository is refused before launch, so `git worktree add` cannot materialize the worktree through that link.
