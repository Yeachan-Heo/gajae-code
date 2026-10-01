### Fixed

- Run compound pipeline stages concurrently to prevent pipe-buffer deadlocks.
- Join remaining pipeline stages when a stage wait returns an error.
