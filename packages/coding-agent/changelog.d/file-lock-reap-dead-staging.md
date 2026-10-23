### Fixed

- File-lock acquisition now reaps same-host staging directories whose recorded process generation is dead, and removes empty or missing-info staging directories only after a 60-second grace period. Foreign-host and live-owner staging directories remain protected, while a rotating bounded scan prevents retained entries from starving later candidates.
