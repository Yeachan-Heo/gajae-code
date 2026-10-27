### Fixed

- Foreground `gjc sdk broker run` loads the publication-liveness watchdog from the bundled module. A `PI_COMPILED` value from the environment or a project `.env` cannot redirect that worker to a file in the repository. The project-root worker path is used only when the running module is inside a compiled binary.
