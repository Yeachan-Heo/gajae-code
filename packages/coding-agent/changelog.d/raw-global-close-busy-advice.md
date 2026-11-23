### Fixed

- A `busy` or `endpoint_stale` refusal from `gjc sdk session raw global --op session.close` now gets the same recovery step as `gjc sdk session close`: a busy close recommends inspecting the session, waiting until it is idle and rerunning the same close with the same key, instead of steering the active turn.
