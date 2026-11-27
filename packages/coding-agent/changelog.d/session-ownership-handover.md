### Added

- With `session.ownership.mode: enforce` (not the default), the held-session warning now offers **Continue here** when the session is held by a host the broker launched, for example a session started from Gajae Mobile, Telegram or `gjc acp`. It closes that host between turns and opens the session in this terminal; attached clients re-attach to the terminal, and an ACP client's next prompt runs there without `session/load`. A host that is running a turn refuses with "The session is running a turn; try again when it finishes." and the warning shows again. Continue here is offered at `gjc --resume <id or path>`, in the `gjc --resume` picker and in `/resume`; never when the holder is another terminal or the app.

### Fixed

- An ACP prompt sent after its session host closed between turns, before the Router attached the session's new owner, failed with "SDK session attachment is stale." It now re-attaches the session through the broker and runs there.
- Under `enforce`, a broker `session.resume` arriving while a terminal takes a session over (its generation-0 row live, the claim not yet taken) refused at once. It now waits for the terminal's endpoint, as it does for a held claim.
