### Fixed

- On Windows, `Process.observe` reports a process that has exited as `absent` even while a handle to it is still open, by checking the handle's exit state with a zero-timeout wait. It previously reported such a process as `present`, so `gjc sdk` commands failed to clean up a broker that had already exited on a lock failure and hid the lock failure behind a cleanup error.
- On Windows, `Process.observe` no longer needs termination rights to report `present`; a live process that denies termination access but allows query and synchronize access is now `present` with its incarnation instead of `unknown`.
