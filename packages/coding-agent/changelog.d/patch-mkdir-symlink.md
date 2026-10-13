### Fixed

- Patch create and move check the real parent directory before mkdir, so a directory symlink cannot create a directory outside the workspace or the session local root.
