### Added

- `/btw` side questions now own their turn: a queued `/btw` waits for idle admission instead of interleaving with a running turn, and its settlement is joined before a session transition (switch, `/new`, dispose) proceeds.

### Fixed

- A `/btw` turn no longer claims the first-turn auto title, so a session that starts with a side question still receives its own generated title.
