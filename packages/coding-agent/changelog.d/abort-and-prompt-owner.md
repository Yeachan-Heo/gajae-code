### Fixed

- `turn.abort_and_prompt` now follows the same ownership rule as `turn.abort`. A connection that does not own the active run, such as another client's prompt or a turn started in the interactive terminal, no longer stops that run. Its replacement text is queued as a steer for the run instead, and the result reports `aborted: false` with `queuedAs: "steer"`. The replacement no longer cancels another connection's pending prompt preflight either. An owner's replacement behaves as before.
