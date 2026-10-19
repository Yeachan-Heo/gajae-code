### Fixed

- GJC's own `git` and `gh` invocations (`/commit`, the github tool's `pr_checkout`/`pr_push`/`pr_create`, autoresearch commits, task worktree trees) now drop project-dotenv hook variables such as `GIT_CONFIG_*` (`core.hooksPath`), `GIT_SSH_COMMAND`, and `GIT_ASKPASS`, matching the bash tool. Previously a repository `.env` could make GJC run repository code, e.g. a pre-commit hook on `/commit` or an ssh helper on push. `gh` output is captured, so `GH_PAGER` is pinned to `cat` and `GH_FORCE_TTY` is removed.
