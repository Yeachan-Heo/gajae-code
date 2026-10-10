### Fixed

- A project `.env` can no longer make bash tool commands run repository code through `BASH_ENV`/`ENV` (sourced by the shell before every command) or `GIT_CONFIG_*`/`GIT_CONFIG_PARAMETERS`/`GIT_EXTERNAL_DIFF` (for example `core.fsmonitor`, which git executes during `git status`). These are now dropped from the bash spawn environment when the project declares them; values exported by the launching shell are kept.
