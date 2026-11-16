### Fixed

- On a notifications-enabled TUI, `turn.abort_and_prompt` again aborts and starts a new run when the requesting connection sends it while its own `turn.prompt` is still in preflight. Cancelling that preflight leaves the session busy until the cancelled prompt finishes unwinding. During that window the replacement was treated as foreign work and queued as a steer. A cancelled preflight now counts as the requester's work until its submission settles, but only while no run has started.
