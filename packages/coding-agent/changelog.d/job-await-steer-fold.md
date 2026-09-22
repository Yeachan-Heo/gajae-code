### Fixed

- A running `job` await now folds on a user steer after the shared foreground grace window, returning promptly while the job keeps its original deadline and remains eligible to wake a later turn with its result. `task` and `subagent` waits remain non-foldable.
