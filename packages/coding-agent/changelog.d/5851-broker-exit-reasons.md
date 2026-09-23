### Fixed

- SDK broker exits now log and persist a bounded structured reason for startup deadlines and pre-readiness signals as well as publication fences, committed restarts, and shutdown requests, so supervisors can diagnose broker restarts (#5851).
