### Changed

- A session opened without its ownership claim (another process held it, or the lock timed out or failed) is claimed again when a turn starts, with backoff. Under the default `observe`, the re-attempt runs beside the turn, so a turn never waits on the lock. A terminal that opened a session while, for example, a session host held it becomes the session's owner at a prompt after that host exits, and `gjc session owners` then lists it. A re-attempt that finds the same outcome again is not counted again in the ownership counters.
- Under `enforce`, a held or failed claim is re-attempted at every turn. A turn on a session another process now holds is not started. The TUI shows the held-session warning with Fork and Cancel and puts the message back in the editor, and `-p` and the SDK get `SessionHeldError`. After that, other writes to the session from this process (a title, a rename, a compaction, an extension's or SDK append) are refused with `SessionHeldError` too, until a background re-attempt finds the holder gone. A claim that fails refuses the turn and other writes, as at open. A re-attempt that times out lets that turn run unclaimed, with a warning.

### Fixed

- One session ownership lock timeout (for example on a stalled network filesystem) no longer turns claims off for the rest of the process. It skips that one claim, and the next claim tries again. Before, a terminal or session host whose claim timed out once kept writing its session unclaimed for its whole life, so other processes could not see it as the session's writer.
