### Fixed

- SDK sessions now properly restore native goal state when resuming a saved session. Previously, closing a session with an active or paused goal and then resuming it would lose the goal mode state, requiring users to manually recreate the goal. The goal mode state is now recovered from the durable session branch during initialization (#7947).
