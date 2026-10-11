### Fixed

- A project `.env` declaration of `GJC_TMUX_COMMAND`, including a dynamic one, no longer selects the tmux binary; the default `tmux` path is used instead, while an operator value the project does not declare is kept.
