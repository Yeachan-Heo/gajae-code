### Fixed

- `session.close` with `ifIdle` now refuses `busy` while a session recap request is still open, instead of accepting the close and aborting the recap.
- `gjc sdk session close --if-idle` rejects a `--json-input` whose `ifIdle` is not `true` as a usage error before contacting the broker, instead of silently overriding it.
- A `busy` refusal from `gjc sdk session close` now recommends inspecting the session, waiting until it is idle and rerunning the same close, rather than steering the active turn; an `endpoint_stale` close refusal now explains that its key is terminal and the session must be inspected before any new close.
