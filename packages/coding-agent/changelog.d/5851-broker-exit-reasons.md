### Fixed

- SDK broker exits now log and persist a bounded structured reason for startup deadlines and pre-readiness signals as well as publication fences, committed restarts, and shutdown requests. Signal-path records use bounded asynchronous writes so slow filesystems cannot block postmortem cleanup. Broker RPCs stay unavailable until retained discovery ownership is proven, so supervisors can diagnose restarts without exposing an unready broker. Windows broker startup also reads managed enrollment state without invoking the Linux-only private publication path (#5851).
