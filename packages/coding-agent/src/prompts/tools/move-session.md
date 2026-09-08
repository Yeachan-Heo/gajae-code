Rescope the session to a narrower working directory.

Use this only when the session's working directory is a broad launcher root (for example a
multi-repo workspace like `~/Projects`) and the task has clearly converged on one subdirectory
or repository: after this call, every later turn resolves relative paths and the bash default
cwd from the new directory, and project-scoped plugins/capabilities reload for it.

- `path` must be an existing directory; relative paths resolve against the current session cwd.
  The canonical target must be strictly inside the current session directory — moves to a
  parent, a sibling project, or an unrelated absolute path are refused.
- A session can be moved this way at most once, and never while another move is running; a
  rejected call does not consume the move. Use it once the target repo is identified — not
  speculatively — because the session file and caches move with the session.
- This tool is unavailable in subagent sessions and restricted profiles; ask the top-level
  session to rescope instead.
- For an explicitly requested sibling or unrelated repository, start a new session with
  `gjc --cwd <approved-worktree>` and delegate from there. A task's `repositoryBinding`
  verifies the session's repository; it cannot authorize relocation. Already-created task
  tools retain their original repository binding even after a user-driven cwd move.
