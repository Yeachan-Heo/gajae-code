### Fixed

- ACP reattachment no longer fails with `ACP session … has no current Router attachment` when the broker still reports a session live but the long-running ACP process's Router holds no attachment for it. Reattachment now falls back to `session.resume`, which re-proves the host and returns its exact endpoint authority or relaunches it.
