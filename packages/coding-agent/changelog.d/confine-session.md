### Added

- Added `--confine`, which keeps a session inside its cwd and descendants and out of ordinary `--continue`/`--resume`. On macOS the shell process itself is sandboxed to that directory.

### Fixed

- Confined sessions now keep that boundary on Cursor file callbacks, hashline edits through in-root symlinks, lifecycle forks, and persistent task children.
