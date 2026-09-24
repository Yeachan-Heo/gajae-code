### Fixed

- SDK broker exits now log and persist a bounded structured reason for startup deadlines and pre-readiness signals as well as publication fences, committed restarts, and shutdown requests. Broker RPCs stay unavailable until retained discovery ownership is proven, so supervisors can diagnose restarts without exposing an unready broker (#5851).
