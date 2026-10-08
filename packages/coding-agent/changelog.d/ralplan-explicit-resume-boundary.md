### Fixed

- Ralplan now distinguishes an explicit resume from a fresh run. Resume preserves the active run's phase—including final/pending approval—and role/review continuity; terminal phases remain locked. Starting over uses a fresh run ID, and an active run requires an explicit `--new-run` choice before its state pointer can be replaced.
