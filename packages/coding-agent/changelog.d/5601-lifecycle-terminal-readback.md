### Fixed

- Keep settled lifecycle outcomes intact when post-persistence read-back is unavailable, preventing successful session creates from being wedged by a spurious `terminal_uncertain` record.
