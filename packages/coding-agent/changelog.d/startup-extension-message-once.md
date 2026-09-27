### Fixed

- A displayed extension message sent from `session_start` (such as a handoff summary) now appears once at startup instead of twice, and startup notices shown before the first paint are no longer wiped. Transcript rebuilds requested before the initial transcript paint are skipped; the first paint renders the full session.
