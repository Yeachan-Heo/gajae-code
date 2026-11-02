### Added

- `btw.ask`: an SDK control that answers one ephemeral `/btw` side question from the live session context. It owns no turn and persists nothing to the session transcript, refuses a second concurrent question with `busy`, and refuses empty or oversized questions as invalid input.
