### Changed

- `glob` now uses the shared native filesystem walker and its bounded scan/cache policy, preserving stable sorted results across ignore rules, symlinks, and large directories.
- Walker Rayon pool initialization now fails closed to serial work; `walkerPoolStatus()` exposes a non-forcing diagnostic, and native load failures during discovery no longer become empty results.
