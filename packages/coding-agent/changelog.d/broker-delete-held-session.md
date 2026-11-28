### Fixed

- Under `session.ownership.mode: enforce`, the broker's `session.delete` (ACP `session/delete`, `gjc sdk`) no longer deletes a session another process holds without a live index row, such as a `gjc -p` run or an embedding. It refuses with `live_session`, the code a live row already gets, naming the holder, before any cleanup starts, and the holder keeps its transcript. A claim that cannot be checked refuses with `unavailable`. `observe` deletes as before.
- A `session.delete` refused before it changed anything (a live or held session, or `unavailable`) is no longer stored as a final result: a retry with the same idempotency key runs again, and a pending cleanup that was refused keeps its receipt and resumes under the same key.
