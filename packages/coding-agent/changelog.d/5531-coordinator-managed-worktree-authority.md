### Fixed

- Coordinator delegate reuse now resolves endpoint authority from the persisted managed-worktree workspace, preserving `not_indexed` status and retrying transient workspace canonicalization failures instead of sealing them as terminal errors (#5531).
- Coordinator delegate reuse reauthorizes the persisted cwd/workspace pair against the current allowed and managed-worktree roots before binding, so a narrowed root or redirected projection refuses with `workspace_mismatch` instead of dispatching outside scope.
- A same-key coordinator delegate retry after a pre-admission failure on a reused session now recovers into a fresh prompt claim; only retries whose prior attempt already started a prompt claim seal as `terminal_uncertain`.
