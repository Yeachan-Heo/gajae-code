### Fixed

- Switching to a different session clears the active checkpoint so a later rewind cannot truncate that session or move its branch to the root.
