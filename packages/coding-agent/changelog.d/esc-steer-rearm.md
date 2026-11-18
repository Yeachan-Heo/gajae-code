### Fixed

- With two or more queued steers in `one-at-a-time` mode, Esc during the continuation that delivered the first steer now silently interrupts and injects the next queued steer instead of hard-aborting the turn and dumping it into the composer. The first-Esc gesture re-arms once the steer-on-interrupt continuation starts; a second Esc before the consumed steer is delivered still cancels and restores the queue to the composer.
