### Fixed

- The bisect tool's `run` predicate now starts with the same environment as a bash tool command: project-declared hook variables are dropped and the non-interactive overrides (`GIT_EDITOR`, `GIT_TERMINAL_PROMPT`, `SSH_ASKPASS`, pager and color settings) apply. Previously the predicate's `sh -c` inherited Bun's autoloaded environment, so on source and npm installs a repository `.env` declaring `NODE_OPTIONS=--require ./x.js`, `LD_PRELOAD`, or `GIT_CONFIG_*` ran repository code inside the predicate at every bisect step, which the same command run through the bash tool would not.
