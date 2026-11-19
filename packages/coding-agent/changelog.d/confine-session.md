### Added

- Added `--confine`, which keeps a session inside its cwd and descendants and out of ordinary `--continue`/`--resume`. On macOS the shell process itself is sandboxed to that directory.

### Fixed

- Confined sessions now keep that boundary on Cursor file callbacks, hashline edits through in-root symlinks, lifecycle forks, and persistent task children.
- Confined file reads, writes, and patch deletes now go through a descriptor-pinned walk beneath the session root, so a parent directory swapped for a symlink after the path check cannot redirect them outside it.
- Confined hashline edits of an existing file no longer fail on a read-only descriptor.
- Confined task children no longer fail to start when their managed transcript was already persisted, and an explicit child transcript path is created confined instead of being rejected.
- Confined `--continue` no longer stops at a newer, oversized opposite-scope transcript before reaching an older matching one.
- Resolving a write conflict in a confined session re-checks and reads the target through the confined path.
- A confined shell command no longer creates or loads the shell snapshot outside the sandbox.
