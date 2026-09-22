### Fixed

- A running `job` await now folds on a user steer after the shared foreground grace window, returning promptly while the job keeps its original deadline and remains eligible to wake a later turn with its result. `task` and `subagent` waits remain non-foldable. The fold chord and the SDK `bash.background` control never target a `job` await (its jobs are already in the background), so a `job poll` cannot steal the chord from the foreground bash the user is watching, and a folded await reports the trigger that actually folded it.
