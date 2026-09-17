### Fixed

- `gjc sdk serve --session <id>` now recovers a session whose host self-reaped after a detached idle window instead of failing terminally. An explicit session that the broker still indexes but reports as not live is re-materialized once through the existing `session.resume` authority the index already carries, then resolved and served normally. A session that is still not live after that attempt fails with the same `endpoint_stale` error as before, and no other targeting outcome retries (#5633).
