### Fixed

- The broker startup signal directory is taken only from the operator environment, including a value loaded before a worktree changes the working directory, so a project dotenv line cannot create that directory or pass it to the broker child. An operator directory the project does not declare is still used.
