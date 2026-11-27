### Changed

- A session opened without its ownership claim (another process held it, or the lock timed out or failed) is claimed again when a turn starts, with backoff. Under the default `observe`, a terminal that opened a session while, for example, a session host held it now becomes the session's owner at its first prompt after that host exits; `gjc session owners` then lists it. Under `enforce`, a turn on a session another process now holds is refused before anything is written: the TUI shows the held-session warning and keeps the message in the editor, and `-p` and the SDK get `SessionHeldError`. A re-attempt that times out lets that turn run unclaimed, with a warning under `enforce`.

### Fixed

- One session ownership lock timeout (for example on a stalled network filesystem) no longer turns claims off for the rest of the process. It skips that one claim, and the next claim tries again. Before, a terminal or session host whose claim timed out once kept writing its session unclaimed for its whole life, so other processes could not see it as the session's writer.
