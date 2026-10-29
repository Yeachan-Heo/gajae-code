### Fixed

- The root command and its tmux relaunch no longer execute a repository dotenv `HERDR_BIN_PATH`. A shell-exported path is still used when the project does not declare that name, or declares a different static path. A dynamic project declaration, or the same static text, is not used; Herdr then resolves the binary from `PATH`.
