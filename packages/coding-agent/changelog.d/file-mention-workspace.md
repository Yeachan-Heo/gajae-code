### Fixed

- Auto-read `@path` mentions now include a file only when its canonical path stays inside the session directory, so `..`, `~`, an outside absolute path, or a symlink cannot insert that file into the prompt.
