### Fixed

- Patch delete checks the real parent directory before unlinking, so a directory symlink cannot remove a file outside the workspace or the session local root.
