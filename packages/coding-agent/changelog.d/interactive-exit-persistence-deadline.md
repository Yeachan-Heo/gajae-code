### Fixed

- Interactive `/exit` now handles a bounded session-disposal timeout without triggering the unhandled-rejection crash path. It restores the terminal, reports that persistence is incomplete, and exits through bounded cleanup with status 1. Underlying persistence ownership and lock safety are unchanged; an ownerless lock left by filesystem synchronization still requires verified recovery.
