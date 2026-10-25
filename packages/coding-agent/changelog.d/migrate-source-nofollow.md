### Fixed

- `gjc migrate` no longer follows a symlinked Claude Code instruction, settings, or skill file outside the home or project root being imported. A rootless Codex or OpenCode config whose final component is a symlink is still read.
