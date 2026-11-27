### Added

- With `session.ownership.mode: enforce` (not the default), the held-session warning now offers **Continue here** when the session is held by a host the broker launched, for example a session started from Gajae Mobile, Telegram or `gjc acp`. It closes that host between turns and opens the session in this terminal; attached clients re-attach to the terminal, and an ACP client's next prompt runs there without `session/load`. A host that is running a turn refuses with "The session is running a turn; try again when it finishes." and the warning shows again. Continue here is offered at `gjc --resume <id or path>`, in the `gjc --resume` picker and in `/resume`; never when the holder is another terminal or the app, and not at `gjc --resume <id>` for a session from another folder, which can only be forked here.

### Changed

- In every ownership mode, an ACP prompt on a session whose host is gone, including one closed on purpose between turns (for example with `gjc sdk session close`), now resumes the session instead of failing. Resume reuses the endpoint of whatever process now holds the session, and launches a host only if nobody holds it. This matches what ACP already does after it loses its connection to a host.

### Fixed

- An ACP prompt sent after its session host closed between turns, before the Router attached the session's new owner, failed with "SDK session attachment is stale." or was abandoned as "host closed (replaced)". It now re-attaches the session through the broker and runs there. If the new owner is not ready yet (a terminal still starting), that one prompt fails as before and the session stays loaded; the next prompt or attachment recovers it without `session/load`. If the saved session is gone, the session reports `session_closed` with the advice to load it again with `session/load`. Temporary sessions keep their own recovery.
- When an idle ACP session's endpoint moved to another process (a terminal that took it over), ACP kept the old host's lifecycle ownership and providers: `session/close` then tried to close the terminal's session. ACP now re-attaches such a session through the broker, so it learns the new host's provenance.
- Under `enforce`, a broker `session.resume` arriving while a terminal takes a session over (its generation-0 row live, the claim not yet taken) refused at once. It now waits for the terminal's endpoint, as it does for a held claim.
