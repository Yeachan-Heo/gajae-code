### Fixed

- The managed atomic-rewrite overflow error no longer advises `gjc export <session-file>`, which is not a command. `SessionNearLimitRewriteError` was added with its own hardcoded copy of the recovery advice and reintroduced the exact string #5621 had removed; it now reuses `SESSION_LIMIT_RECOVERY_ACTIONS` like the append path, so both near-limit errors stay in sync. The guidance regression test covers every near-limit error class rather than only the append one (#5621).
