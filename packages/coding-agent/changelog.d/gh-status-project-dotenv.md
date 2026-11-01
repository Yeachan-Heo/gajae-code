### Fixed

- The `gh` calls GJC makes on its own -- the status line's PR lookup for the current branch and the star reminder's check -- now use the same environment as the github tool's `gh`: project-dotenv hook variables are dropped, `GH_PAGER` is pinned to `cat`, and `GH_FORCE_TTY` is removed. Previously, on source and npm installs, a repository `.env` declaring `NODE_OPTIONS`, `LD_PRELOAD`, `GH_PAGER`, or `GH_FORCE_TTY` reached those background `gh` processes (and the git they run) as soon as the status line showed a feature branch.
