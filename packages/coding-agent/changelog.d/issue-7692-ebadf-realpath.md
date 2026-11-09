### Fixed

- On Windows, when another process is concurrently releasing a lock file, `fs.realpath` can raise `EBADF` instead of `ENOENT`. This is now handled gracefully in `localLockKey()` by treating `EBADF` the same as `ENOENT` on Windows and falling back to parent-based key derivation, matching the intended semantics of a vanishing lock file. ([#7692](https://github.com/Yeachan-Heo/gajae-code/issues/7692))
