### Fixed

- Bash expansion of rule and memory URLs stays inside the current session, including a non-Git project rule whose real path stays in an ancestor rule directory below the home directory, so one session cannot read or append another session's files.
