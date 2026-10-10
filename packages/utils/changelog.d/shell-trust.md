### Fixed

- When the launching shell does not export `SHELL`, a project `.env` declaration of `SHELL` no longer selects the shell that runs bash tool commands with the agent's environment and credentials; the inherited value or the standard bash/sh fallback is used instead.
