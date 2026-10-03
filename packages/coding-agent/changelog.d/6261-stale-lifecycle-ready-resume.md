### Fixed

- `session.resume` of a session whose detached-idle host already exited no longer fails with `EEXIST` on `<id>.lifecycle.ready.json`: the host revokes its own ready marker on graceful exit, including the global SIGTERM path, and a launch retires the same id's leftover ready/marker pair when the recorded owner is proven exited (a live or unknown owner still wins) (#6261).
