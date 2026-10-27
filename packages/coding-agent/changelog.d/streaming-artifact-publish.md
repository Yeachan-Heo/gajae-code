### Fixed
- Streaming artifact output is published as mode 0600 without following a destination symlink, and an existing regular file is still updated when its parent directory is not writable.
