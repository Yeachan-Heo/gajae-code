### Fixed

- `gjc sdk spawn` no longer rejects a child host that registered in time with `child_registration_timeout` just because the broker's session index read finished after the 8 s admission deadline. A read that began within the deadline is now evaluated against the full identity, authority and liveness check, waiting in the index queue or on the index lock is bounded by the remaining budget, and each poll projects only the awaited child.
- A `child_registration_timeout` failure message now says whether no registration row was observed, a row was observed but did not match the launched host, or the session index could not be read in time.
