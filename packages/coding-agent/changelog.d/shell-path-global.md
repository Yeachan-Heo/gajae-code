### Fixed

- A repository `.gjc/settings.json` `shellPath` no longer selects the shell. A `shellPath` in the user settings file is still used. Bash runs that shell. The Python executor uses the shell environment from the same resolver and runs its own Python path.
