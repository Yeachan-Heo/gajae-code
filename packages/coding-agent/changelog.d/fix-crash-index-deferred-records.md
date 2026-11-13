### Fixed

- A crash record dated more than 24 hours ahead of the clock is now picked up once the clock catches up. The crash-log identity cache skipped every later scan of an unchanged log, so a record deferred for its future timestamp stayed out of the crash index until the log changed. Compaction no longer caches the identity while any record is deferred. ([#7759](https://github.com/Yeachan-Heo/gajae-code/issues/7759))
