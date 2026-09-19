### Fixed

- Coordinator delegate reuse now resolves endpoint authority from the persisted managed-worktree workspace, preserving `not_indexed` status and retrying transient workspace canonicalization failures instead of sealing them as terminal errors (#5531).
