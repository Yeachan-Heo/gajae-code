### Fixed
- Bash expansion of `skill://` paths now rejects a symlink that leaves the skill directory, and still expands a missing file whose real ancestors stay inside that directory.
