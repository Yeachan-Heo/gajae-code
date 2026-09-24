### Fixed

- Coordinator `gjc_coordinator_start_session` now binds recovered creation intents using the same timestamp-insensitive semantic digest as its WAL, so retries after interrupted creation succeed without weakening conflicts for changed launch inputs (#5899).
