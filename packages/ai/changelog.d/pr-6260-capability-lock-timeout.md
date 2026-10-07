### Fixed

- Replace Atomics.wait() with Bun.sleepSync() and add a 2-second timeout to tool-choice capability cache lock acquisition to prevent indefinite waits during concurrent process contention.
