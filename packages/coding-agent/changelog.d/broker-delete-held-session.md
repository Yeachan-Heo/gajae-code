### Fixed

- Under `session.ownership.mode: enforce`, the broker's `session.delete` (ACP `session/delete`, Telegram, `gjc sdk`) no longer deletes a session another process holds without a live index row, such as a `gjc -p` run or an embedding. It refuses with `live_session`, the code a live row already gets, before any cleanup starts, and the holder keeps its transcript. `observe` deletes as before.
