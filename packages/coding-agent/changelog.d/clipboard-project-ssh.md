### Fixed

- A repository `.gjc/config.yml` or `.gjc/settings.json` can no longer set `clipboard.transport` or `clipboard.sshHost`, and a non-object `clipboard` value there cannot replace the user clipboard settings. User config and the clipboard CLI flags still can.
