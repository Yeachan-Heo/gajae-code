### Fixed

- The opportunistic file-lock staging reaper no longer throws `ENOENT` when a candidate directory is published by its winning acquirer between `readdir` and inspection. `inspectFileLockStagingDir` now treats a missing staging root as a normal `enoent_already_gone` non-removal result instead of propagating the error up through `reapOrphanedLockStagingDirs` and into the `Failed to reap orphaned file-lock staging directories` debug warning (observed ~154 times/day on `sessions/index.jsonl.lock`). The post-removal `detachedPath` observation and its `rmdir` are guarded the same way.
