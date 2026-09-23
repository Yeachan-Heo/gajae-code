### Fixed

- SDK broker graceful exits now log and persist a bounded structured reason, including publication-fence and signal details, so supervisors can diagnose broker restarts (#5851).
